// packages/web/src/chat/SlashMenu.tsx — the `/` command palette (320px cap).
// Pure presentation: filtering and keyboard state live in InputBar.

export interface SlashEntry {
  group: string
  /** Full invocation; a trailing ` <text>` marks an argument-taking command. */
  label: string
  desc: string
}

export const SLASH_ENTRIES: SlashEntry[] = [
  { group: 'Mode', label: '/mode observe', desc: 'Watch only, no input' },
  { group: 'Mode', label: '/mode assist', desc: 'Act with approval' },
  { group: 'Mode', label: '/mode full', desc: 'Act autonomously' },
  { group: 'Board', label: '/tasks', desc: 'List the task board' },
  { group: 'Board', label: '/mission <text>', desc: 'Append to MISSION.md' },
  { group: 'Budget', label: '/budget', desc: "Today's token budget" },
  { group: 'Help', label: '/help', desc: 'All commands' },
]

/** Typed prefix matches when it starts the label, or extends the label's base. */
export function slashMatches(value: string, label: string): boolean {
  const base = label.replace(/ <text>$/, '')
  return base.startsWith(value) || value.startsWith(base)
}

export function filterSlash(value: string): SlashEntry[] {
  return SLASH_ENTRIES.filter((e) => slashMatches(value, e.label))
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
    <div className="slash" role="listbox" aria-label="Slash commands">
      {entries.length === 0 ? (
        <div className="slash-empty">no matching command — try /help</div>
      ) : (
        entries.map((e, idx) => {
          const header = e.group !== lastGroup ? <div className="slash-group">{e.group}</div> : null
          lastGroup = e.group
          return (
            <div key={e.label}>
              {header}
              <button
                type="button"
                role="option"
                aria-selected={idx === activeIdx}
                className={`slash-item${idx === activeIdx ? ' active' : ''}`}
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
