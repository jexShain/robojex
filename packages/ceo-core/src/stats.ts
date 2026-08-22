// packages/ceo-core/src/stats.ts — read side of the R8 experience ledger
// (runtime/STATS.md, appended line-by-line by the loop's appendStat as
// `framework|verdict|title`). Folds the ledger tail into a per-agent track
// record for GET /api/stats and the command-center strip. Deliberately
// independent from loop.ts's statsBlock() (its prompt-side twin) — the api
// never reaches into loop internals; both read the same file format.
export interface AgentStat {
  framework: string;
  total: number;    // pass + partial + fail (unknown verdicts don't count)
  pass: number;
  partial: number;
  fail: number;
  passRate: number; // 0-100, Math.round(pass / total); 0 when nothing counted
  recent: string[]; // titles of the agent's last 3 ledger lines, append order
}

/** Pure: fold the last 200 `framework|verdict|title` lines of a STATS.md
 *  payload into per-agent aggregates, busiest agent first (total desc, then
 *  name asc). Lines without a "|", or missing framework/verdict, are
 *  skipped; an unknown verdict contributes no count but keeps its title.
 *  Empty / all-bad input → []. */
export function aggregateStats(raw: string): AgentStat[] {
  const lines = raw.split("\n").filter((l) => l.includes("|")).slice(-200);
  const byAgent = new Map<string, { pass: number; partial: number; fail: number; titles: string[] }>();
  for (const line of lines) {
    const [fw, verdict, title] = line.split("|");
    const framework = (fw ?? "").trim();
    const v = (verdict ?? "").trim();
    if (!framework || !v) continue; // bad line: skip, keep counting the rest
    const s = byAgent.get(framework) ?? { pass: 0, partial: 0, fail: 0, titles: [] };
    if (v === "pass") s.pass++;
    else if (v === "partial") s.partial++;
    else if (v === "fail") s.fail++;
    if (title && title.trim()) s.titles.push(title.trim());
    byAgent.set(framework, s);
  }
  return [...byAgent.entries()]
    .map(([framework, s]) => {
      const total = s.pass + s.partial + s.fail;
      return {
        framework,
        total,
        pass: s.pass,
        partial: s.partial,
        fail: s.fail,
        passRate: total > 0 ? Math.round((s.pass / total) * 100) : 0,
        recent: s.titles.slice(-3),
      };
    })
    .sort((a, b) => b.total - a.total || a.framework.localeCompare(b.framework));
}
