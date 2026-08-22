// packages/web/src/views/SettingsView.tsx — settings modal (React rewrite of
// the broken preact version). Left tab nav + right form: AI provider
// (baseUrl / masked apiKey), model + gears, budget, connection (read-only),
// about. Loads via state/api.ts; saves a minimal dirty patch via PUT
// /api/settings. Esc and backdrop click close.

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../state/api'
import { useStore } from '../state/store'
import type { Settings } from '../state/types'
import { gearsOrFallback } from './gearDefs'
import '../styles/settings.css'

type TabId = 'provider' | 'model' | 'budget' | 'connection' | 'about'

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'provider', label: 'AI 提供商', icon: '⚡' },
  { id: 'model', label: '模型与挡位', icon: '🧠' },
  { id: 'budget', label: '预算', icon: '💰' },
  { id: 'connection', label: '连接', icon: '🔗' },
  { id: 'about', label: '关于', icon: 'ℹ️' },
]

const GITHUB_URL = 'https://github.com/jexShain/robojex'
const TECH_STACK = 'React 18 · TypeScript · Vite · Electron · ceo-core (Node.js) · DeepSeek API'

interface Draft {
  baseUrl: string
  budgetMode: 'burn' | 'budgeted'
  dailyTokens: string
}

export function SettingsView({ onClose }: { onClose(): void }) {
  const store = useStore()
  const { state } = store
  const [tab, setTab] = useState<TabId>('provider')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Draft>({ baseUrl: '', budgetMode: 'burn', dailyTokens: '' })
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

  const dirty = Object.keys(patch).length > 0
  const canSave = dirty && tokensValid && !saving && !loading

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
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
            ) : !settings ? (
              <div className="st-loading">设置不可用 — 检查后端连接后重试</div>
            ) : tab === 'provider' ? (
              <section className="st-section">
                <h3>AI 提供商</h3>
                <p className="st-desc">LLM 网关凭据。key 由后端保管，界面只显示掩码。</p>
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
              </section>
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
