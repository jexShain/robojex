// packages/web/src/details/DetailsPanel.tsx — right column: selected task
// detail (status/verdict/progress/acceptance badges), read-only
// MISSION/RUBRIC/MEMORY views with copy buttons, and the takeoverd live
// screen preview. AppFrame controls column visibility (display none).

import { useState } from 'react'
import { useStore, statusTone } from '../state/store'
import { TakeoverPreview } from './TakeoverPreview'

type Tab = 'task' | 'files' | 'screen'

const VERDICT_LABEL: Record<string, string> = {
  pass: '✓ 通过',
  partial: '◐ 部分',
  fail: '✗ 未过',
  unchecked: '○ 未验',
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
      title={`复制 ${label}`}
      aria-label={`复制 ${label}`}
      onClick={copy}
    >
      {done ? '✓ 已复制' : '⧉ 复制'}
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
  const task =
    state.selectedTaskId !== null
      ? state.tasks.find((t) => t.id === state.selectedTaskId) ?? null
      : null
  if (!task) {
    return <div className="detail-hint">select a task in the sidebar</div>
  }
  const verdict = task.verdict ? task.verdict.toLowerCase() : null
  const verdictKey = verdict && verdict in VERDICT_LABEL ? verdict : verdict ? 'unchecked' : null
  const progress = typeof task.progress === 'number' ? Math.max(0, Math.min(100, Math.round(task.progress))) : null
  return (
    <div>
      <h2 className="detail-title">{task.title}</h2>
      {(verdictKey || progress !== null) && (
        <div className="detail-badges">
          {progress !== null ? (
            <span className={`db progress ${progress >= 100 ? 'ok' : ''}`}>进度 {progress}%</span>
          ) : null}
          {verdictKey ? <span className={`db verdict v-${verdictKey}`}>{VERDICT_LABEL[verdictKey]}</span> : null}
        </div>
      )}
      <div className="kv">
        <span className="k">id</span>
        <span className="v" style={{ fontFamily: 'var(--ds-font-family-code)' }}>
          {task.id}
        </span>
      </div>
      <div className="kv">
        <span className="k">status</span>
        <span className="v">
          <span className={`dot ${statusTone(task.status)}`} style={{ display: 'inline-block', marginRight: 6 }} />
          {task.status}
        </span>
      </div>
      <div className="kv">
        <span className="k">created</span>
        <span className="v">{new Date(task.createdAt).toLocaleString()}</span>
      </div>
      {task.scheduledAt != null ? (
        <div className="kv">
          <span className="k">scheduled</span>
          <span className="v">{new Date(task.scheduledAt).toLocaleString()}</span>
        </div>
      ) : null}
      {task.dueAt != null ? (
        <div className="kv">
          <span className="k">due</span>
          <span className="v">{new Date(task.dueAt).toLocaleString()}</span>
        </div>
      ) : null}
      {task.acceptance ? (
        <div className="kv">
          <span className="k">acceptance</span>
          <span className="v summary">{task.acceptance}</span>
        </div>
      ) : null}
      {task.resultSummary ? (
        <div className="kv">
          <span className="k">result</span>
          <span className="v summary">{task.resultSummary}</span>
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
  const [tab, setTab] = useState<Tab>('task')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'task', label: '任务' },
    { id: 'files', label: '文件' },
    { id: 'screen', label: '屏幕' },
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
          title="Close details"
          aria-label="Close details"
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
