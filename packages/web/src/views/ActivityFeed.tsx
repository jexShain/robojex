// packages/web/src/views/ActivityFeed.tsx — real-time activity feed
// (Vercel-style log). Subscribes to activityItems from the store.

import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { formatTime } from './activityModel'
import type { ActivityItem } from '../state/types'

const DETAIL_TYPES = new Set<string>(['heroku', 'claude-code', 'codex', 'opencode'])

function frameworkBadge(detail: string | undefined): string | null {
 if (!detail) return null
 for (const fw of DETAIL_TYPES) {
   if (detail.toLowerCase().includes(fw)) return fw
 }
 return null
}

function ItemRow({ item }: { item: ActivityItem }) {
 const { t } = useT()
 const fw = (item.type === 'spawn' || item.type === 'task_done') ? frameworkBadge(item.detail) : null
 // fixed labels translate via labelKey; dynamic titles (task names, budget
 // lines) render as-is — they belong to the data, not the chrome
 const label = item.labelKey
   ? fill(t(item.labelKey), { n: item.labelParam ?? '' })
   : item.title

 return (
   <div className="activity-item rj-animate-in">
     <div className={`activity-dot ${item.color}`} />
     <div className="activity-content">
       <div className="activity-item-title">
         {item.type === 'task_done' ? '✓ ' : item.type === 'task_blocked' ? '✗ ' : null}
         {label}
         {fw ? <span className={`fw-badge ${fw}`}>{fw}</span> : null}
       </div>
       {item.detail ? <div className="activity-item-detail">{item.detail}</div> : null}
     </div>
     <div className="activity-item-time">{formatTime(item.ts)}</div>
   </div>
 )
}

export function ActivityFeed() {
 const listRef = useRef<HTMLDivElement>(null)
 // We subscribe via the store hook which triggers re-render on any state change.
 // The activityItems array is also exposed; we read it directly.
 const store = useStore()
 const { t } = useT()
 // Access activityItems through the store API
 const items = store.activityItems

 // Auto-scroll to top when new items arrive
 const prevLen = useRef(items.length)
 useEffect(() => {
   if (items.length > prevLen.current && listRef.current) {
     listRef.current.scrollTo({ top: 0, behavior: 'smooth' })
   }
   prevLen.current = items.length
 }, [items.length])

 return (
   <div className="activity-feed">
     <div className="activity-header">
       <span className="activity-title">{t('act.title')}</span>
       <span className="activity-pulse" />
     </div>
     <div className="activity-list" ref={listRef}>
       {items.length === 0 ? (
         <div className="activity-empty">
           <div className="activity-skeleton" aria-hidden="true">
             {[0, 1, 2, 3, 4].map((i) => (
               <div key={i} className="rj-skeleton" style={{ animationDelay: `${i * 0.15}s` }} />
             ))}
           </div>
           <p>{t('act.empty')}</p>
         </div>
       ) : (
         items.map((item) => <ItemRow key={item.id} item={item} />)
       )}
     </div>
   </div>
 )
}
