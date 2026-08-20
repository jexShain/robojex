// packages/ceo-core/src/budget.ts
export type BudgetMode = "burn" | "budgeted";

// local calendar day (not UTC): the allowance is a human "today" concept
function localDay(d: Date): string { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

export class BudgetGovernor {
  private used = 0;
  private day: string;
  constructor(private mode: BudgetMode, private dailyTokens = 0, private now: () => Date = () => new Date()) {
    this.day = localDay(this.now());
  }
  spend(u: { promptTokens: number; completionTokens: number }): void { this.used += u.promptTokens + u.completionTokens; }
  // called before any read: crossing local midnight starts a fresh allowance
  private rollover(): void {
    const d = localDay(this.now());
    if (d !== this.day) { this.day = d; this.used = 0; }
  }
  gate(): "full" | "patrol-only" | "observe-only" {
    this.rollover();
    if (this.mode === "burn" || this.dailyTokens <= 0) return "full";
    const ratio = this.used / this.dailyTokens;
    if (ratio < 0.9) return "full";
    if (ratio < 1.0) return "patrol-only";
    return "observe-only";
  }
  line(): string {
    this.rollover();
    if (this.mode === "burn") return `budget mode: burn (spent ${this.used} tokens, unlimited)`;
    const r = this.gate();
    return `budget: ${this.used}/${this.dailyTokens} tokens (${r === "observe-only" ? "exhausted — observe only" : r})`;
  }

  // One-shot view for the api state frame: mode, cap, spend and the human line.
  snapshot(): { mode: BudgetMode; dailyTokens: number; spentToday: number; line: string } {
    this.rollover();
    return { mode: this.mode, dailyTokens: this.dailyTokens, spentToday: this.used, line: this.line() };
  }
  reset(): void { this.used = 0; }
}
