// packages/takeoverd/src/modes.ts
export type Mode = "observe" | "assist" | "full";
const ORDER: Mode[] = ["observe", "assist", "full"];

export class ModeStateMachine {
  private mode: Mode = "observe"; // safe default on every boot
  get current(): Mode { return this.mode; }
  next(): void {
    this.mode = ORDER[(ORDER.indexOf(this.mode) + 1) % ORDER.length];
  }
  set(m: Mode): void {
    if (!ORDER.includes(m)) throw new Error(`unknown mode: ${m}`);
    this.mode = m;
  }
  // observe answers false regardless of callers — injector is never wired in observe
  canInject(): boolean { return this.mode !== "observe"; }
  needsApproval(): boolean { return this.mode === "assist"; }
}
