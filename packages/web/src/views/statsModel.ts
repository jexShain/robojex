// packages/web/src/views/statsModel.ts — pure helpers for the command
// center's agent-record strip (GET /api/stats): the pass-rate tone bucket
// that drives row coloring. No DOM imports so it runs in vitest's node env.

export type StatsTone = 'good' | 'mid' | 'bad'

/** Pass-rate → tone bucket: ≥70% green (good), 40–69% amber (mid), <40% red
 *  (bad). Boundaries land on the higher band. Mirrors the R8 ledger's job:
 *  tell the operator at a glance who is trustworthy. Pure. */
export function statsTone(passRate: number): StatsTone {
  if (passRate >= 70) return 'good'
  return passRate >= 40 ? 'mid' : 'bad'
}
