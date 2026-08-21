// packages/web/src/chat/SlashMenu.tsx — the `/` command palette. Entries are
// the full runCommand set from the store (gear/model/models/theme/jex/mode/
// tasks/mission/budget/help), grouped and filtered by typed prefix. Keyboard
// state lives in InputBar; this file is presentation + pure filter helpers.

export interface SlashEntry {
  group: string
  /** Full invocation; a trailing ` <…>` marks an argument-taking command. */
  label: string
  desc: string
}

export const SLASH_ENTRIES: SlashEntry[] = [
  /* 挡位 */
  { group: '挡位', label: '/gear dormant', desc: '😴 休眠 · 零自主，仅直聊' },
  { group: '挡位', label: '/gear eco', desc: '🌱 省电 · 极省 token' },
  { group: '挡位', label: '/gear balanced', desc: '⚖️ 均衡 · 默认自主' },
  { group: '挡位', label: '/gear focused', desc: '🎯 专注 · 主动推进任务' },
  { group: '挡位', label: '/gear turbo', desc: '🚀 狂暴 · 最大自主' },
  /* 模型 */
  { group: '模型', label: '/model <名称>', desc: '切换聊天模型' },
  { group: '模型', label: '/models', desc: '列出可用模型' },
  /* 主题 */
  { group: '主题', label: '/theme light', desc: '浅色主题' },
  { group: '主题', label: '/theme dark', desc: '深色主题' },
  { group: '主题', label: '/theme system', desc: '跟随系统' },
  /* jex 编排 */
  { group: 'jex 编排', label: '/jex <文本>', desc: '发给 jex 编排循环（自主任务）' },
  { group: 'jex 编排', label: '/mode observe', desc: '仅观察，不执行' },
  { group: 'jex 编排', label: '/mode assist', desc: '辅助执行' },
  { group: 'jex 编排', label: '/mode full', desc: '完全自主' },
  /* 任务 */
  { group: '任务', label: '/tasks', desc: '查看任务板' },
  { group: '任务', label: '/mission <文本>', desc: '追加到 MISSION.md' },
  /* 预算 */
  { group: '预算', label: '/budget', desc: '今日 token 预算' },
  /* 帮助 */
  { group: '帮助', label: '/help', desc: '全部命令列表' },
]

/** Typed prefix matches when it starts the entry's base command, or extends it
 * (so `/gear tu` finds `/gear turbo`, and `/model deepseek-v4` still matches
 * the generic `/model` entry for argument completion). */
export function slashMatches(value: string, label: string): boolean {
  const base = label.replace(/ <[^>]*>$/, '')
  return base.startsWith(value) || value.startsWith(base)
}

export function filterSlash(value: string): SlashEntry[] {
  const v = value.trim()
  if (!v.startsWith('/')) return []
  return SLASH_ENTRIES.filter((e) => slashMatches(v, e.label))
}

export function SlashMenu({
  entries,
  activeIdx,
  onHover,
  onPick,
}: {
  entries: SlashEntry[]
  activeIdx: number
  onHover(idx: number): void
  onPick(entry: SlashEntry): void
}) {
  let lastGroup = ''
  return (
    <div className="slm" role="listbox" aria-label="斜杠命令">
      {entries.length === 0 ? (
        <div className="slm-empty">没有匹配的命令 — 试试 /help</div>
      ) : (
        entries.map((e, idx) => {
          const header = e.group !== lastGroup ? <div className="slm-group">{e.group}</div> : null
          lastGroup = e.group
          return (
            <div key={e.label}>
              {header}
              <button
                type="button"
                role="option"
                aria-selected={idx === activeIdx}
                className={`slm-item${idx === activeIdx ? ' active' : ''}`}
                onMouseEnter={() => onHover(idx)}
                onMouseDown={(ev) => {
                  // mousedown beats blur: pick before the textarea loses focus.
                  ev.preventDefault()
                  onPick(e)
                }}
              >
                <span className="name">{e.label}</span>
                <span className="desc">{e.desc}</span>
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
