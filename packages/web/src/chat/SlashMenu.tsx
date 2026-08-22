// packages/web/src/chat/SlashMenu.tsx — the `/` command palette. Entries are
// the full runCommand set from the store (gear/model/models/theme/lang/jex/
// mode/tasks/mission/budget/help), grouped and filtered by typed prefix.
// Command tokens (labels) stay verbatim across languages; groups + descs are
// dictionary keys translated at render. Keyboard state lives in InputBar; this
// file is presentation + pure filter helpers.

import { useT } from '../i18n'

export interface SlashEntry {
  groupKey: string
  /** Full invocation — the command token itself, never translated; a
   * trailing ` <…>` marks an argument-taking command. */
  label: string
  descKey: string
}

export const SLASH_ENTRIES: SlashEntry[] = [
  /* 挡位 / gear */
  { groupKey: 'slash.group.gear', label: '/gear dormant', descKey: 'slash.gearDormant' },
  { groupKey: 'slash.group.gear', label: '/gear eco', descKey: 'slash.gearEco' },
  { groupKey: 'slash.group.gear', label: '/gear balanced', descKey: 'slash.gearBalanced' },
  { groupKey: 'slash.group.gear', label: '/gear focused', descKey: 'slash.gearFocused' },
  { groupKey: 'slash.group.gear', label: '/gear turbo', descKey: 'slash.gearTurbo' },
  /* 模型 / model — placeholders stay language-neutral (<name>/<text>) so the
   * command token itself never changes between locales */
  { groupKey: 'slash.group.model', label: '/model <name>', descKey: 'slash.modelSet' },
  { groupKey: 'slash.group.model', label: '/models', descKey: 'slash.modelsList' },
  /* 主题 / theme */
  { groupKey: 'slash.group.theme', label: '/theme light', descKey: 'slash.themeLight' },
  { groupKey: 'slash.group.theme', label: '/theme dark', descKey: 'slash.themeDark' },
  { groupKey: 'slash.group.theme', label: '/theme system', descKey: 'slash.themeSystem' },
  /* 语言 / language */
  { groupKey: 'slash.group.lang', label: '/lang <zh|en|system>', descKey: 'slash.langSet' },
  /* jex 编排 / orchestration */
  { groupKey: 'slash.group.jex', label: '/jex <text>', descKey: 'slash.jexSend' },
  { groupKey: 'slash.group.jex', label: '/mode observe', descKey: 'slash.modeObserve' },
  { groupKey: 'slash.group.jex', label: '/mode assist', descKey: 'slash.modeAssist' },
  { groupKey: 'slash.group.jex', label: '/mode full', descKey: 'slash.modeFull' },
  /* 任务 / tasks */
  { groupKey: 'slash.group.task', label: '/tasks', descKey: 'slash.tasks' },
  { groupKey: 'slash.group.task', label: '/mission <text>', descKey: 'slash.mission' },
  /* 预算 / budget */
  { groupKey: 'slash.group.budget', label: '/budget', descKey: 'slash.budget' },
  /* 帮助 / help */
  { groupKey: 'slash.group.help', label: '/help', descKey: 'slash.help' },
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
  const { t } = useT()
  let lastGroup = ''
  return (
    <div className="slm" role="listbox" aria-label={t('slash.aria')}>
      {entries.length === 0 ? (
        <div className="slm-empty">{t('slash.empty')}</div>
      ) : (
        entries.map((e, idx) => {
          const header = e.groupKey !== lastGroup ? <div className="slm-group">{t(e.groupKey)}</div> : null
          lastGroup = e.groupKey
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
                <span className="desc">{t(e.descKey)}</span>
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}
