// packages/ceo-core/src/budget.ts
export type BudgetMode = "burn" | "budgeted";

export class BudgetGovernor {
  private used = 0;
  constructor(private mode: BudgetMode, private dailyTokens = 0) {}
  spend(u: { promptTokens: number; completionTokens: number }): void { this.used += u.promptTokens + u.completionTokens; }
  gate(): "full" | "patrol-only" | "observe-only" {
    if (this.mode === "burn" || this.dailyTokens <= 0) return "full";
    const ratio = this.used / this.dailyTokens;
    if (ratio < 0.9) return "full";
    if (ratio < 1.0) return "patrol-only";
    return "observe-only";
  }
  line(): string {
    if (this.mode === "burn") return `budget mode: burn (spent ${this.used} tokens, unlimited)`;
    const r = this.gate();
    return `budget: ${this.used}/${this.dailyTokens} tokens (${r === "observe-only" ? "exhausted — observe only" : r})`;
  }
  reset(): void { this.used = 0; }
}
