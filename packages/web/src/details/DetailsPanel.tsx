// packages/web/src/details/DetailsPanel.tsx — right column: selected task
// detail (status/verdict/progress/acceptance badges + operator cancel),
// read-only MISSION/RUBRIC/MEMORY views with copy buttons, and the takeoverd
// live screen preview. AppFrame controls column visibility (display none).

import { useEffect, useRef, useState } from 'react'
import { useStore, statusTone } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { Icon } from '../ui/Icon'
import { TakeoverPreview } from './TakeoverPreview'
import { parseQuickTime } from '../views/quickTime'

type Tab = 'task' | 'files' | 'screen'

/** Valid verdict keys (label lookup goes through the verdict.* dictionary). */
const VERDICT_KEYS = ['pass', 'partial', 'fail', 'unchecked'] as const

/** Verdicts that carry acceptance evidence in resultSummary (the verify note
 * is appended there — the tail is the latest evidence). */
const EVIDENCE_VERDICTS: ReadonlySet<string> = new Set(['pass', 'partial', 'fail'])

/** Tail slice of a resultSummary shown on the verdict badge hover: the most
 * recent verify note rides at the end, so the tail IS the evidence. */
function evidenceTail(summary: string | undefined): string | undefined {
  if (!summary || summary.length === 0) return undefined
  return summary.length > 200 ? `…${summary.slice(-200)}` : summary
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useT()
  const [done, setDone] = useState(false)
  const copy = (): void => {
    const fallback = (): void => {
      // clipboard API unavailable (insecure context) — legacy execCommand path
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // best-effort only
      }
      document.body.removeChild(ta)
    }
    const p = navigator.clipboard?.writeText(text)
    if (p) void p.then(() => setDone(true)).catch(() => setDone(false))
    else {
      fallback()
      setDone(true)
    }
    window.setTimeout(() => setDone(false), 1600)
  }
  return (
    <button
      type="button"
      className="file-copy"
      title={fill(t('detail.copyTitle'), { label })}
      aria-label={fill(t('detail.copyTitle'), { label })}
      onClick={copy}
    >
      {done ? t('detail.copiedBtn') : t('detail.copyBtn')}
    </button>
  )
}

function FileView({ label, text }: { label: string; text: string }) {
  return (
    <div className="file-block">
      <div className="file-head">
        <span className="file-label">{label}</span>
        <CopyButton text={text} label={label} />
      </div>
      <pre className="file-pre">{text}</pre>
    </div>
  )
}

/** epoch ms → datetime-local value (local timezone, minute precision). */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Quiet inline datetime field: reads as text, edits as a native picker.
 *  Saving is the keyboard/precision sibling of the agenda's drag gestures
 *  (and their a11y alternative). Empty clears. */
function TimeField({ ms, onPick, ariaLabel }: { ms: number | null; onPick(v: number | null): void; ariaLabel: string }) {
  const [v, setV] = useState(ms != null ? toLocalInput(ms) : '')
  useEffect(() => setV(ms != null ? toLocalInput(ms) : ''), [ms])
  const commit = (): void => {
    const next = v === '' ? null : new Date(v).getTime()
    if (next === ms || (next !== null && Number.isNaN(next))) return
    onPick(next)
  }
  return (
    <input
      type="datetime-local"
      className="kv-time"
      aria-label={ariaLabel}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
    />
  )
}

function TaskDetail() {
  const { state, selectTask } = useStore()
  const { t } = useT()
  const [cancelErr, setCancelErr] = useState(false)
  const [doneErr, setDoneErr] = useState(false)
  // two-step arm for mark-done (done is terminal, same as cancel): first click
  // arms for 2.5s, second fires, timeout stands down
  const [doneArmed, setDoneArmed] = useState(false)
  const doneTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(doneTimer.current), [])
  const task =
    state.selectedTaskId !== null
      ? state.tasks.find((t) => t.id === state.selectedTaskId) ?? null
      : null
  if (!task) {
    return <div className="detail-hint">{t('detail.selectHint')}</div>
  }
  // operator cancel — the board card's hover trash is the fast path; this is
  // the deliberate one, next to the full card context
  const cancellable = task.status !== 'done' && task.status !== 'cancelled'
  const cancel = (): void => {
    setCancelErr(false)
    void fetch('/api/task', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: task.id, status: 'cancelled' }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return undefined })
      .catch(() => setCancelErr(true))
  }
  // operator done — "settled it myself": only never-dispatched todo cards
  // (server refuses agent-owned ones; hide rather than show a dying button)
  const doneable = task.status === 'todo' && (task.assignee ?? '') === ''
  const markDone = (): void => {
    setDoneErr(false)
    void fetch('/api/task', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: task.id, status: 'done' }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return undefined })
      .catch(() => setDoneErr(true))
  }
  // add-a-step: plans gain a missed step without going back to the board;
  // quick-time syntax works here too (steps often carry their own clock)
  const [addingStep, setAddingStep] = useState(false)
  const [stepTitle, setStepTitle] = useState('')
  const [stepErr, setStepErr] = useState(false)
  const stepInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (addingStep) stepInputRef.current?.focus()
  }, [addingStep])
  const addStep = (): void => {
    const raw = stepTitle.trim()
    if (!raw) return
    setStepErr(false)
    const quick = parseQuickTime(raw)
    void fetch('/api/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: quick?.title ?? raw,
        parentId: task.id,
        ...(quick?.scheduledAt !== undefined ? { scheduledAt: quick.scheduledAt } : {}),
        ...(quick?.dueAt !== undefined ? { dueAt: quick.dueAt } : {}),
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        setStepTitle('')
        return undefined
      })
      .catch(() => setStepErr(true))
  }
  // precise time edits ride the same PATCH as the drag gestures; null clears
  const patchTime = (fields: { scheduledAt?: number | null; dueAt?: number | null }): void => {
    setCancelErr(false)
    void fetch('/api/task', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: task.id, ...fields }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return undefined })
      .catch(() => setCancelErr(true))
  }
  // rename: a typo shouldn't cost cancel+recreate (times and children would
  // go with it). Inline edit on the title, same PATCH as the time fields.
  const renamable = task.status !== 'done' && task.status !== 'cancelled'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameErr, setRenameErr] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) renameRef.current?.focus()
  }, [editing])
  const commitRename = (): void => {
    const raw = draft.trim()
    setEditing(false)
    if (!raw || raw === task.title) return
    setRenameErr(false)
    void fetch('/api/task', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: task.id, title: raw }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return undefined })
      .catch(() => setRenameErr(true))
  }
  const verdict = task.verdict ? task.verdict.toLowerCase() : null
  const verdictKey =
    verdict && (VERDICT_KEYS as readonly string[]).includes(verdict)
      ? verdict
      : verdict
        ? 'unchecked'
        : null
  // verdict hover shows the evidence: the tail of resultSummary (the verify
  // note is appended there, so the tail is the latest check's grounds)
  const verdictTitle =
    verdictKey !== null && EVIDENCE_VERDICTS.has(verdictKey) ? evidenceTail(task.resultSummary) : undefined
  const progress = typeof task.progress === 'number' ? Math.max(0, Math.min(100, Math.round(task.progress))) : null
  return (
    <div>
      {editing ? (
        <input
          ref={renameRef}
          className="detail-title-input"
          value={draft}
          aria-label={t('detail.rename')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commitRename}
        />
      ) : (
        <div className="detail-title-row">
          <h2 className="detail-title">{task.title}</h2>
          {renamable ? (
            <button
              type="button"
              className="dt-edit"
              title={t('detail.rename')}
              aria-label={t('detail.rename')}
              onClick={() => {
                setDraft(task.title)
                setEditing(true)
              }}
            >
              <Icon name="pencil" size={12} />
            </button>
          ) : null}
        </div>
      )}
      {renameErr ? (
        <span className="da-err" role="alert">{t('detail.renameErr')}</span>
      ) : null}
      {(verdictKey || progress !== null) && (
        <div className="detail-badges">
          {progress !== null ? (
            <span className={`db progress ${progress >= 100 ? 'ok' : ''}`}>{fill(t('detail.progress'), { n: progress })}</span>
          ) : null}
          {verdictKey ? (
            <span className={`db verdict v-${verdictKey}`} title={verdictTitle}>
              {t(`verdict.${verdictKey}`)}
            </span>
          ) : null}
        </div>
      )}
      <div className="kv">
        <span className="k">{t('detail.kId')}</span>
        <span className="v" style={{ fontFamily: 'var(--ds-font-family-code)' }}>
          {task.id}
        </span>
      </div>
      <div className="kv">
        <span className="k">{t('detail.kStatus')}</span>
        <span className="v">
          <span className={`dot ${statusTone(task.status)}`} style={{ display: 'inline-block', marginRight: 6 }} />
          {t(`status.${task.status}`)}
        </span>
      </div>
      <div className="kv">
        <span className="k">{t('detail.kCreated')}</span>
        <span className="v">{new Date(task.createdAt).toLocaleString()}</span>
      </div>
      {cancellable ? (
        <div className="kv">
          <span className="k">{t('detail.kScheduled')}</span>
          <span className="v">
            <TimeField
              ms={task.scheduledAt ?? null}
              ariaLabel={t('detail.editSched')}
              onPick={(v) => patchTime({ scheduledAt: v })}
            />
          </span>
        </div>
      ) : task.scheduledAt != null ? (
        <div className="kv">
          <span className="k">{t('detail.kScheduled')}</span>
          <span className="v">{new Date(task.scheduledAt).toLocaleString()}</span>
        </div>
      ) : null}
      {cancellable ? (
        <div className="kv">
          <span className="k">{t('detail.kDue')}</span>
          <span className="v">
            <TimeField
              ms={task.dueAt ?? null}
              ariaLabel={t('detail.editDue')}
              onPick={(v) => patchTime({ dueAt: v })}
            />
          </span>
        </div>
      ) : task.dueAt != null ? (
        <div className="kv">
          <span className="k">{t('detail.kDue')}</span>
          <span className="v">{new Date(task.dueAt).toLocaleString()}</span>
        </div>
      ) : null}
      {task.acceptance ? (
        <div className="kv">
          <span className="k">{t('detail.kAcceptance')}</span>
          <span className="v summary oneline" title={task.acceptance}>
            {task.acceptance}
          </span>
        </div>
      ) : null}
      {task.resultSummary ? (
        <div className="kv">
          <span className="k">{t('detail.kResult')}</span>
          <span className="v summary">{task.resultSummary}</span>
        </div>
      ) : null}
      {(() => {
        // family navigation: plans arrive as a parent plus steps — walking
        // the tree from the detail rail beats hunting cards on the board
        const parent = task.parentId != null ? state.tasks.find((x) => x.id === task.parentId) : undefined
        const kids = state.tasks.filter((x) => x.parentId === task.id && x.status !== 'cancelled')
        const stepAddable = task.status !== 'done' && task.status !== 'cancelled'
        if (!parent && kids.length === 0 && !stepAddable) return null
        return (
          <div className="detail-family">
            {parent ? (
              <button type="button" className="df-link" onClick={() => selectTask(parent.id)} title={parent.title}>
                <Icon name="chevronRight" size={10} style={{ transform: 'rotate(-90deg)' }} />
                <span className="df-tag">{t('detail.parent')}</span>
                <span className="df-name">{parent.title}</span>
              </button>
            ) : null}
            {kids.length > 0 ? (
              <div className="df-kids">
                <span className="df-tag">
                  <Icon name="chevronDown" size={10} /> {t('detail.kids')}
                </span>
                {kids.slice(0, 6).map((k) => (
                  <button key={k.id} type="button" className="df-link" onClick={() => selectTask(k.id)} title={k.title}>
                    {k.title}
                  </button>
                ))}
                {kids.length > 6 ? <span className="df-more">+{kids.length - 6}</span> : null}
              </div>
            ) : null}
            {stepAddable ? (
              addingStep ? (
                <div className="df-add">
                  <input
                    ref={stepInputRef}
                    className="df-add-input"
                    value={stepTitle}
                    placeholder={t('board.newPlaceholder')}
                    onChange={(e) => setStepTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addStep()
                      else if (e.key === 'Escape') setAddingStep(false)
                    }}
                    onBlur={() => { if (!stepTitle.trim()) setAddingStep(false) }}
                  />
                  <button
                    type="button"
                    className="df-add-btn"
                    title={t('detail.addStep')}
                    disabled={!stepTitle.trim()}
                    onClick={addStep}
                  >
                    <Icon name="plus" size={11} />
                  </button>
                  {stepErr ? <span className="da-err" role="alert">{t('detail.addStepErr')}</span> : null}
                </div>
              ) : (
                <button type="button" className="df-add-open" onClick={() => setAddingStep(true)}>
                  <Icon name="plus" size={10} /> {t('detail.addStep')}
                </button>
              )
            ) : null}
          </div>
        )
      })()}
      {(doneable || cancellable) ? (
        <div className="detail-actions">
          {doneable ? (
            <button
              type="button"
              className={`da-done${doneArmed ? ' armed' : ''}`}
              title={doneArmed ? t('detail.confirmDone') : t('detail.markDone')}
              aria-pressed={doneArmed}
              onClick={() => {
                if (!doneArmed) {
                  setDoneArmed(true)
                  window.clearTimeout(doneTimer.current)
                  doneTimer.current = window.setTimeout(() => setDoneArmed(false), 2_500)
                  return
                }
                window.clearTimeout(doneTimer.current)
                markDone()
              }}
            >
              <Icon name="check" size={12} />
              {doneArmed ? t('detail.confirmDone') : t('detail.markDone')}
            </button>
          ) : null}
          {cancellable ? (
            <button
              type="button"
              className="da-cancel"
              title={t('detail.cancelTask')}
              onClick={cancel}
            >
              <Icon name="trash" size={12} />
              {t('detail.cancelTask')}
            </button>
          ) : null}
          {cancelErr ? (
            <span className="da-err" role="alert">{t('detail.cancelErr')}</span>
          ) : null}
          {doneErr ? (
            <span className="da-err" role="alert">{t('detail.doneErr')}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function FilesView() {
  const { state } = useStore()
  return (
    <>
      <FileView label="MISSION.md" text={state.mission} />
      <FileView label="RUBRIC.md" text={state.rubric} />
      <FileView label="MEMORY.md" text={state.memory} />
    </>
  )
}

export function DetailsPanel({ onClose }: { onClose(): void }) {
  const { t } = useT()
  // Esc closes the panel — except while a form control holds focus (the
  // datetime-local picker consumes Esc itself to stand down its edit)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && el.closest('input, textarea, select, [contenteditable="true"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const [tab, setTab] = useState<Tab>('task')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'task', label: t('detail.tabTask') },
    { id: 'files', label: t('detail.tabFiles') },
    { id: 'screen', label: t('detail.tabScreen') },
  ]
  return (
    <div className="details">
      <div className="details-head">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          title={t('detail.close')}
          aria-label={t('detail.close')}
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="details-body">
        {tab === 'task' ? <TaskDetail /> : null}
        {tab === 'files' ? <FilesView /> : null}
        {tab === 'screen' ? <TakeoverPreview /> : null}
      </div>
    </div>
  )
}
