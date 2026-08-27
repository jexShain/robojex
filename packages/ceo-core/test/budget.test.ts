// packages/ceo-core/test/budget.test.ts
import { BudgetGovernor } from "../src/budget.js";
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("burn mode never gates", () => {
  const b = new BudgetGovernor("burn");
  for (let i = 0; i < 100; i++) b.spend({ promptTokens: 10_000, completionTokens: 1000 });
  expect(b.gate()).toBe("full");
  expect(b.line()).toContain("burn");
});

test("budgeted degrades at 90% and exhausts", () => {
  const b = new BudgetGovernor("budgeted", 1000);
  b.spend({ promptTokens: 800, completionTokens: 50 }); // 85%
  expect(b.gate()).toBe("full");
  b.spend({ promptTokens: 60, completionTokens: 0 });   // 91%
  expect(b.gate()).toBe("patrol-only");
  b.spend({ promptTokens: 200, completionTokens: 0 });  // >100%
  expect(b.gate()).toBe("observe-only");
  expect(b.line()).toMatch(/exhausted|observe/);
});

test("daily rollover: a new local day resets the allowance via gate()", () => {
  let now = new Date(2026, 7, 17, 23, 55);
  const b = new BudgetGovernor("budgeted", 1000, () => now);
  b.spend({ promptTokens: 1200, completionTokens: 0 });
  expect(b.gate()).toBe("observe-only");
  now = new Date(2026, 7, 18, 0, 5); // past local midnight
  expect(b.gate()).toBe("full");
  expect(b.line()).toContain("0/1000");
  b.spend({ promptTokens: 800, completionTokens: 0 });
  expect(b.gate()).toBe("full"); // fresh day: 80% is still full
});

test("daily rollover: line() alone also detects the day change", () => {
  let now = new Date(2026, 7, 17, 12, 0);
  const b = new BudgetGovernor("budgeted", 1000, () => now);
  b.spend({ promptTokens: 999, completionTokens: 0 });
  now = new Date(2026, 7, 19, 12, 0); // two days later
  expect(b.line()).toContain("0/1000");
  expect(b.gate()).toBe("full");
});

test("same local day: no reset", () => {
  const b = new BudgetGovernor("budgeted", 1000, () => new Date(2026, 7, 17, 1, 0));
  b.spend({ promptTokens: 500, completionTokens: 0 });
  expect(b.line()).toContain("500/1000");
});

test("persisted ledger: a restart picks the same day's tab back up", () => {
  // live soak 08-27: an R142 redeploy mid-day took spentToday 53k → 25k —
  // the morning's burn vanished from the human-facing budget line
  const dir = mkdtempSync(join(tmpdir(), "rjbudget-"));
  let now = new Date(2026, 7, 27, 10, 0);
  const a = new BudgetGovernor("burn", 0, () => now, dir);
  a.spend({ promptTokens: 3_000, completionTokens: 200 });
  expect(a.snapshot().spentToday).toBe(3_200);

  const b = new BudgetGovernor("burn", 0, () => now, dir); // "restart"
  expect(b.snapshot().spentToday).toBe(3_200); // same day: tab carried over
  b.spend({ promptTokens: 100, completionTokens: 0 });
  expect(readFileSync(join(dir, "budget.json"), "utf8")).toContain("3300");

  now = new Date(2026, 7, 28, 9, 0); // next day, still "restarted"
  const c = new BudgetGovernor("burn", 0, () => now, dir);
  expect(c.snapshot().spentToday).toBe(0); // new day: fresh allowance
});

test("no persistDir: behavior unchanged (backward compat)", () => {
  const b = new BudgetGovernor("burn");
  b.spend({ promptTokens: 100, completionTokens: 0 });
  const c = new BudgetGovernor("burn");
  expect(c.snapshot().spentToday).toBe(0); // no ledger → independent
});
