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
