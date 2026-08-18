// packages/ceo-core/test/budget.test.ts
import { BudgetGovernor } from "../src/budget.js";
import { expect, test } from "vitest";

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
