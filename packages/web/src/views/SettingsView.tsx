// packages/web/src/views/SettingsView.tsx — settings modal (React rewrite of
// the broken preact version). Left tab nav + right form: AI provider
// (connection mode + baseUrl / masked apiKey, with the localStorage-only
// browser-direct fallback), model + gears, budget, connection (read-only),
// about. Loads via state/api.ts; saves a minimal dirty patch via PUT
// /api/settings. Esc and backdrop click close.

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../state/api'
import { useStore } from '../state/store'
import type { Settings } from '../state/types'
import { gearsOrFallback } from './gearDefs'
import '../styles/settings.css'

type TabId = 'provider' | 'model' | 'budget' | 'shortcut' | 'connection' | 'about'

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'provider', label: 'AI 提供商', icon: '⚡' },
  { id: 'model', label: '模型与挡位', icon: '🧠' },
  { id: 'budget', label: '预算', icon: '💰' },
  { id: 'shortcut', label: '快捷键', icon: '⌨️' },
  { id: 'connection', label: '连接', icon: '🔗' },
  { id: 'about', label: '关于', icon: 'ℹ️' },
]

const GITHUB_URL = 'https://github.com/jexShain/robojex'
const TECH_STACK = 'React 18 · TypeScript · Vite · Electron · ceo-core (Node.js) · DeepSeek API'

/** Static shortcut list (SPEC §3.3 快捷键说明); Electron-only rows say so. */
const SHORTCUTS: { keys: string[]; desc: string }[] = [
  { keys: ['Ctrl', 'K'], desc: '命令面板' },
  { keys: ['Esc'], desc: '关闭弹层' },
  { keys: ['Shift', 'Enter'], desc: '换行' },
  { keys: ['↑', '↓'], desc: '输入历史' },
  { keys: ['/'], desc: '命令菜单（输入 / 触发）' },
  { keys: ['@'], desc: '挡位提及（输入 @ 触发）' },
  { keys: ['Alt', 'Space'], desc: '迷你问答窗（Electron）' },
  { keys: ['Ctrl', 'Shift', 'J'], desc: '显示主窗（Electron）' },
  { keys: ['Ctrl', 'N'], desc: '新对话（Electron 菜单）' },
]

interface Draft {
  baseUrl: string
  budgetMode: 'burn' | 'budgeted'
  dailyTokens: string
}

/** Direct-connection draft (SPEC §1 fallback) — localStorage-backed, kept
 * separate from the backend Draft because it must stay editable while the
 * gateway (and thus GET /api/settings) is unreachable. */
interface DirectDraft {
  mode: 'gateway' | 'direct'
  baseUrl: string
  model: string
}

export function SettingsView({ onClose }: { onClose(): void }) {
  const store = useStore()
  const { state } = store
  const [tab, setTab] = useState<TabId>('provider')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Draft>({ baseUrl: '', budgetMode: 'burn', dailyTokens: '' })
  const [directDraft, setDirectDraft] = useState<DirectDraft>(() => ({
    mode: state.direct.mode,
    baseUrl: state.direct.baseUrl,
    model: state.direct.model,
  }))
  const [directKeyInput, setDirectKeyInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null)

  const showToast = useCallback((tone: 'ok' | 'err', msg: string) => {
    setToast({ tone, msg })
    window.setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 4000)
  }, [])

  // Load settings (+ model list for the model tab) on mount.
  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .getSettings()
      .then((s) => {
        if (!alive) return
        setSettings(s)
        setDraft({
          baseUrl: s.baseUrl,
          budgetMode: s.budgetMode,
          dailyTokens: String(s.dailyTokens),
        })
      })
      .catch((err: unknown) => {
        if (alive) showToast('err', `加载设置失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    void store.refreshModels()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc closes (focus lives inside the modal, so the keydown lands here).
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Numeric validation for the daily-token cap.
  const tokensNum = Number(draft.dailyTokens)
  const tokensValid =
    draft.budgetMode === 'burn' || (Number.isInteger(tokensNum) && tokensNum > 0)
  const apiKeyReady = apiKeyInput.trim().startsWith('sk-')

  // Minimal dirty patch — only fields that actually changed.
  const patch = useMemo<Partial<Settings>>(() => {
    const p: Partial<Settings> = {}
    if (!settings) return p
    if (draft.baseUrl.trim() !== settings.baseUrl) p.baseUrl = draft.baseUrl.trim()
    if (apiKeyReady) p.apiKey = apiKeyInput.trim()
    if (draft.budgetMode !== settings.budgetMode) p.budgetMode = draft.budgetMode
    if (draft.budgetMode === 'budgeted' && tokensValid && tokensNum !== settings.dailyTokens) {
      p.dailyTokens = tokensNum
    }
    return p
  }, [settings, draft, apiKeyInput, apiKeyReady, tokensNum, tokensValid])

  // Direct-mode dirty patch — same minimal-diff idea against localStorage.
  const directPatch = useMemo<Partial<api.DirectPrefs>>(() => {
    const p: Partial<api.DirectPrefs> = {}
    if (directDraft.mode !== state.direct.mode) p.mode = directDraft.mode
    if (directDraft.baseUrl.trim() !== state.direct.baseUrl) p.baseUrl = directDraft.baseUrl.trim()
    if (directDraft.model.trim() !== state.direct.model) p.model = directDraft.model.trim()
    if (directKeyInput.trim()) p.apiKey = directKeyInput.trim()
    return p
  }, [directDraft, directKeyInput, state.direct])

  const dirty = Object.keys(patch).length > 0 || Object.keys(directPatch).length > 0
  const canSave = dirty && tokensValid && !saving && !loading

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    // direct prefs persist to localStorage FIRST — the fallback must stay
    // configurable even when the gateway (and its REST save) is unreachable
    if (Object.keys(directPatch).length > 0) {
      store.setDirectPrefs(directPatch)
      const next = { ...state.direct, ...directPatch }
      setDirectDraft({ mode: next.mode, baseUrl: next.baseUrl, model: next.model })
      setDirectKeyInput('')
    }
    if (Object.keys(patch).length === 0) {
      showToast('ok', '直连设置已保存（仅本机浏览器）')
      setSaving(false)
      return
    }
    api
      .putSettings(patch)
      .then(() => api.getSettings())
      .then((s) => {
        setSettings(s)
        setDraft({
          baseUrl: s.baseUrl,
          budgetMode: s.budgetMode,
          dailyTokens: String(s.dailyTokens),
        })
        setApiKeyInput('')
        showToast('ok', '已保存，部分项重启后端后生效')
      })
      .catch((err: unknown) => {
        showToast('err', `保存失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => setSaving(false))
  }

  const gears = gearsOrFallback(state.gears)
  const models = state.models.includes(state.model) || !state.model
    ? state.models
    : [state.model, ...state.models]

  return (
    <div
      className="st-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="st-modal"
        data-testid="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        ref={(el) => el?.focus()}
      >
        <div className="st-head">
          <span className="st-title">⚙ 设置</span>
          <button type="button" className="st-close" title="关闭 (Esc)" aria-label="关闭设置" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="st-body">
          <nav className="st-nav" aria-label="设置分区">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`st-nav-item${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="st-nav-icon">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="st-content">
            {loading ? (
              <div className="st-loading">加载设置中…</div>
            ) : tab === 'provider' ? (
              <section className="st-section">
                <h3>AI 提供商</h3>
                <p className="st-desc">
                  连接模式与 LLM 凭据：默认走本地网关（key 不进浏览器），后端不可用时可切换浏览器直连兜底。
                </p>
                <div className="st-field">
                  <span className="st-label">连接模式</span>
                  <div className="st-radios st-mode-radios" role="radiogroup" aria-label="连接模式">
                    <button
                      type="button"
                      className={`st-radio${directDraft.mode === 'gateway' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={directDraft.mode === 'gateway'}
                      data-testid="direct-mode-gateway"
                      onClick={() => setDirectDraft({ ...directDraft, mode: 'gateway' })}
                    >
                      🛡 本地网关<span>默认 · key 由后端保管</span>
                    </button>
                    <button
                      type="button"
                      className={`st-radio${directDraft.mode === 'direct' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={directDraft.mode === 'direct'}
                      data-testid="direct-mode-direct"
                      onClick={() => setDirectDraft({ ...directDraft, mode: 'direct' })}
                    >
                      🌐 浏览器直连<span>兜底 · 输入自己的 key</span>
                    </button>
                  </div>
                  <span className="st-hint">直连时由渲染进程直接请求 DeepSeek，不经过本地服务</span>
                </div>
                {directDraft.mode === 'direct' ? (
                  <div className="st-direct" data-testid="direct-fields">
                    <label className="st-field">
                      <span className="st-label">直连 Base URL</span>
                      <input
                        className="st-input"
                        data-testid="direct-baseurl"
                        value={directDraft.baseUrl}
                        placeholder={api.DEFAULT_DIRECT_BASE}
                        spellCheck={false}
                        onChange={(e) => setDirectDraft({ ...directDraft, baseUrl: e.target.value })}
                      />
                      <span className="st-hint">OpenAI 兼容端点（POST /chat/completions）</span>
                    </label>
                    <label className="st-field">
                      <span className="st-label">直连 API Key</span>
                      <input
                        className="st-input"
                        type="password"
                        data-testid="direct-apikey"
                        value={directKeyInput}
                        placeholder={state.direct.apiKey ? 'sk-…（已保存 — 重新输入可覆盖）' : 'sk-…'}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setDirectKeyInput(e.target.value)}
                      />
                      <span className="st-hint">key 仅存本机浏览器、直连时不经过本地服务</span>
                    </label>
                    <label className="st-field">
                      <span className="st-label">直连模型</span>
                      <input
                        className="st-input"
                        data-testid="direct-model"
                        value={directDraft.model}
                        placeholder={state.model}
                        spellCheck={false}
                        onChange={(e) => setDirectDraft({ ...directDraft, model: e.target.value })}
                      />
                      <span className="st-hint">留空沿用当前聊天模型（{state.model}）</span>
                    </label>
                    <p className="st-direct-note">
                      兜底模式取舍：会话与消息仅存于本页、刷新后丢失；会话列表 / 挡位等后端功能不可用，仅聊天流可用。
                    </p>
                  </div>
                ) : null}
                {settings ? (
                  <>
                    <span className="st-group-label">本地网关（key 由后端保管，界面只显示掩码）</span>
                    <label className="st-field">
                      <span className="st-label">API Base URL</span>
                      <input
                        className="st-input"
                        value={draft.baseUrl}
                        placeholder="https://api.deepseek.com/v1"
                        spellCheck={false}
                        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                      />
                      <span className="st-hint">LLM 提供商端点</span>
                    </label>
                    <label className="st-field">
                      <span className="st-label">API Key</span>
                      <input
                        className="st-input"
                        type="password"
                        value={apiKeyInput}
                        placeholder={settings.apiKey || 'sk-…'}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setApiKeyInput(e.target.value)}
                      />
                      <span className="st-hint">
                        {apiKeyInput === ''
                          ? `当前：${settings.apiKey || '未设置'} — 留空保持不变`
                          : apiKeyReady
                            ? '将提交新 key'
                            : '仅当以 sk- 开头才会在保存时提交'}
                      </span>
                    </label>
                  </>
                ) : (
                  <p className="st-hint">后端未连接 — 网关凭据暂不可改，可先配置浏览器直连兜底。</p>
                )}
              </section>
            ) : !settings ? (
              <div className="st-loading">设置不可用 — 检查后端连接后重试</div>
            ) : tab === 'model' ? (
              <section className="st-section">
                <h3>模型与挡位</h3>
                <p className="st-desc">直聊模型（立即生效）与 jex 自主挡位（热切换）。</p>
                <label className="st-field">
                  <span className="st-label">聊天模型</span>
                  <select
                    className="st-input"
                    value={state.model}
                    onChange={(e) => store.setModel(e.target.value)}
                  >
                    {models.length === 0 ? <option value={state.model}>{state.model}</option> : null}
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="st-hint">
                    {state.models.length === 0 ? '列表为空 — 后端 /api/models 未返回（仍可经 /model 命令设置）' : `共 ${models.length} 个可用模型`}
                  </span>
                </label>
                <div className="st-gear-grid">
                  {gears.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      className={`st-gear-card${state.gear === g.id ? ' current' : ''}`}
                      onClick={() => void store.changeGear(g.id)}
                      aria-pressed={state.gear === g.id}
                    >
                      <span className="sg-emoji">{g.emoji}</span>
                      <span className="sg-name">{g.name}</span>
                      <span className="sg-id">{g.id} · L{g.level}</span>
                      <span className="sg-desc">{g.desc}</span>
                      <span className="sg-meta">
                        <span>{g.cost}</span>
                        <span>{g.tickMs > 0 ? `${g.tickMs / 1000}s/tick` : '停'}</span>
                        <span>{g.decideMaxTokens > 0 ? `${g.decideMaxTokens} tok` : '—'}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : tab === 'budget' ? (
              <section className="st-section">
                <h3>预算</h3>
                <p className="st-desc">burn 不设限；budgeted 按日封顶，超限后循环暂停。</p>
                <div className="st-radios" role="radiogroup" aria-label="预算模式">
                  <button
                    type="button"
                    className={`st-radio${draft.budgetMode === 'burn' ? ' on' : ''}`}
                    role="radio"
                    aria-checked={draft.budgetMode === 'burn'}
                    onClick={() => setDraft({ ...draft, budgetMode: 'burn' })}
                  >
                    🔥 burn<span>不设限燃烧</span>
                  </button>
                  <button
                    type="button"
                    className={`st-radio${draft.budgetMode === 'budgeted' ? ' on' : ''}`}
                    role="radio"
                    aria-checked={draft.budgetMode === 'budgeted'}
                    onClick={() => setDraft({ ...draft, budgetMode: 'budgeted' })}
                  >
                    📊 budgeted<span>按日封顶</span>
                  </button>
                </div>
                <label className="st-field">
                  <span className="st-label">每日 token 上限</span>
                  <input
                    className="st-input"
                    type="number"
                    min={1}
                    step={1000}
                    value={draft.dailyTokens}
                    disabled={draft.budgetMode === 'burn'}
                    onChange={(e) => setDraft({ ...draft, dailyTokens: e.target.value })}
                  />
                  <span className={`st-hint${tokensValid ? '' : ' err'}`}>
                    {tokensValid ? 'budgeted 模式下生效的正整数' : '请输入正整数（token 数）'}
                  </span>
                </label>
              </section>
            ) : tab === 'shortcut' ? (
              <section className="st-section">
                <h3>快捷键</h3>
                <p className="st-desc">标注（Electron）的仅在桌面端生效，其余为界面内快捷键。</p>
                <div className="st-keys">
                  {SHORTCUTS.map((s) => (
                    <div className="st-key-row" key={s.desc}>
                      <span className="st-key-desc">{s.desc}</span>
                      <span className="st-key-caps">
                        {s.keys.map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : tab === 'connection' ? (
              <section className="st-section">
                <h3>连接</h3>
                <p className="st-desc">由后端配置决定，只读展示。</p>
                <div className="st-kv">
                  <span className="k">takeover URL</span>
                  <span className="v">{settings.takeoverUrl || '—'}</span>
                </div>
                <div className="st-kv">
                  <span className="k">API 端口</span>
                  <span className="v">{settings.apiPort}</span>
                </div>
                <div className="st-kv">
                  <span className="k">API 主机</span>
                  <span className="v">{settings.apiHost}</span>
                </div>
                <div className="st-kv">
                  <span className="k">WS 状态</span>
                  <span className={`v st-conn ${state.conn}`}>● {state.conn}</span>
                </div>
                <div className="st-kv">
                  <span className="k">版本</span>
                  <span className="v">{state.version || '—'}</span>
                </div>
              </section>
            ) : (
              <section className="st-section">
                <h3>关于</h3>
                <div className="st-about">
                  <div className="st-about-orb">🤖</div>
                  <div className="st-about-name">RoboJex</div>
                  <div className="st-about-ver">version {state.version || '—'}</div>
                  <p className="st-about-desc">
                    常驻桌面的人工智能系统：直聊（DeepSeek 流式）+ jex 编排循环（任务板 / 巡逻 /
                    派发 sub-agent）+ 自主挡位。
                  </p>
                  <div className="st-about-stack">{TECH_STACK}</div>
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                    GitHub Repository ↗
                  </a>
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="st-foot">
          <span className={`st-dirty${dirty ? ' on' : ''}`}>
            {saving ? '保存中…' : dirty ? '● 有未保存的修改' : '无未保存修改'}
          </span>
          <button type="button" className="st-save" disabled={!canSave} onClick={save}>
            {saving ? '⏳ 保存中…' : '💾 保存'}
          </button>
        </div>

        {toast ? <div className={`st-toast ${toast.tone}`}>{toast.msg}</div> : null}
      </div>
    </div>
  )
}

export default SettingsView
