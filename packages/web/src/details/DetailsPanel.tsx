// packages/web/src/details/DetailsPanel.tsx — right column: selected task
// detail (status/verdict/progress/acceptance badges + operator cancel),
// read-only MISSION/RUBRIC/MEMORY views with copy buttons, and the takeoverd
// live screen preview. AppFrame controls column visibility (display none).

import { useState } from 'react'
import { useStore, statusTone } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { Icon } from '../ui/Icon'
import { TakeoverPreview } from './TakeoverPreview'

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

function TaskDetail() {
  const { state } = useStore()
  const { t } = useT()
  const [cancelErr, setCancelErr] = useState(false)
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
      <h2 className="detail-title">{task.title}</h2>
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
      {task.scheduledAt != null ? (
        <div className="kv">
          <span className="k">{t('detail.kScheduled')}</span>
          <span className="v">{new Date(task.scheduledAt).toLocaleString()}</span>
        </div>
      ) : null}
      {task.dueAt != null ? (
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
      {cancellable ? (
        <div className="detail-actions">
          <button
            type="button"
            className="da-cancel"
            title={t('detail.cancelTask')}
            onClick={cancel}
          >
            <Icon name="trash" size={12} />
            {t('detail.cancelTask')}
          </button>
          {cancelErr ? (
            <span className="da-err" role="alert">{t('detail.cancelErr')}</span>
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
