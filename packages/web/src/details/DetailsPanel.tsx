// packages/web/src/details/DetailsPanel.tsx — right column: selected task
// detail (status/result/created), read-only MISSION/RUBRIC/MEMORY views, and
// the takeoverd live screen preview.

import { useState } from 'react'
import { useStore, statusTone } from '../state/store'
import { TakeoverPreview } from './TakeoverPreview'

type Tab = 'task' | 'files' | 'screen'

function FileView({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="file-label">{label}</div>
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
  return (
    <div>
      <h2 className="detail-title">{task.title}</h2>
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
    { id: 'task', label: 'Task' },
    { id: 'files', label: 'Files' },
    { id: 'screen', label: 'Screen' },
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
