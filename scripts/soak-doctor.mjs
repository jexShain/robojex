#!/usr/bin/env node
// scripts/soak-doctor.mjs — one-shot soak health report (read-only; the
// daemon keeps running untouched). Consolidates the hourly patrol check
// into a single command:
//   node scripts/soak-doctor.mjs [runtimeDir=.soak] [apiBase=http://127.0.0.1:7630]
// Exit 0 healthy · 1 needs attention. A snapshot (.soak/doctor-last.json)
// carries tickN/spend/memory-size between runs so cadence is checked against
// REAL elapsed time, not a guessed interval.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".soak");
const API = process.argv[3] ?? "http://127.0.0.1:7630";
const SNAP = join(RT, "doctor-last.json");
const problems = [];
const notes = [];

// 1. liveness + headline numbers
let state = null;
try {
  const r = await fetch(`${API}/api/state`, { signal: AbortSignal.timeout(3000) });
  state = await r.json();
} catch {
  console.log(`✗ API dead at ${API} — restart with: bash scripts/soak-grd.sh stop && bash scripts/soak-grd.sh start`);
  process.exit(1);
}
const tickN = state.tickN ?? 0;
const spent = state.budget?.spentToday ?? 0;
console.log(`tick=${tickN} spent=${spent} mode=${state.mode} gear=${state.gear}`);

// 2. tick cadence vs last snapshot (allow >= half the wall-clock rate)
const now = Date.now();
if (existsSync(SNAP)) {
  try {
    const prev = JSON.parse(readFileSync(SNAP, "utf8"));
    const mins = (now - prev.at) / 60000;
    const gained = tickN - prev.tickN;
    if (gained < 0) notes.push(`daemon restarted (tick ${prev.tickN}→${tickN}) — cadence/burn window resets this run`);
    else {
      if (gained < mins / 2) problems.push(`tick stalled: +${gained} in ${mins.toFixed(0)}min`);
      if (gained > mins * 3) problems.push(`tick runaway: +${gained} in ${mins.toFixed(0)}min`);
    }
    const burn = (spent - prev.spent) / Math.max(mins / 60, 0.1);
    if (burn > 25000) problems.push(`burn ${Math.round(burn).toLocaleString()}/h — hot (boot/brief hours are fine once; sustained means a loop)`);
    else if (burn > 8000) notes.push(`burn ${Math.round(burn).toLocaleString()}/h (boot/brief/rescan windows are by design)`);
  } catch { /* corrupt snapshot — rewrite below */ }
}
writeFileSync(SNAP, JSON.stringify({ at: now, tickN, spent }));

// 3. last hour of decisions: cost shape + duplicate failure stacking
const db = new DatabaseSync(join(RT, "traces.sqlite"), { readOnly: true });
const hourAgo = now - 3600_000;
const rows = db.prepare(
  "SELECT ts, context_digest, cost, actions FROM decisions WHERE ts > ? ORDER BY ts"
).all(hourAgo);
const sum = rows.reduce((a, r) => a + (r.cost || 0), 0);
const fails = {};
for (const r of rows) {
  const a = String(r.actions || "");
  if (/action failed|invalid|refused/i.test(a)) fails[a.slice(0, 90)] = (fails[a.slice(0, 90)] || 0) + 1;
}
const stacked = Object.entries(fails).filter(([, n]) => n >= 3);
if (stacked.length) problems.push(`failure stacking: ${stacked.map(([k, n]) => `${n}× ${k}`).join("; ")}`);
console.log(`decisions(last 1h)=${rows.length} cost=${sum.toLocaleString()}`);
for (const r of rows.slice(-3)) {
  console.log(`  ${new Date(r.ts).toISOString().slice(5, 16)} ${String(r.cost).padStart(6)} ${(r.context_digest || "").slice(0, 40).padEnd(40)} ${String(r.actions || "").replace(/\s+/g, " ").slice(0, 70)}`);
}

// 4. MEMORY.md bloat guard (R86 gate is content-level; this is size-level)
try {
  const msize = statSync(join(RT, "MEMORY.md")).size;
  console.log(`MEMORY.md=${msize}B`);
  if (msize > 120_000) problems.push(`MEMORY.md ${msize}B — rotation (R43) should have kicked in`);
} catch { notes.push("MEMORY.md absent (fresh runtime)"); }

for (const n of notes) console.log(`· ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  process.exit(1);
}
console.log("✓ soak healthy");
