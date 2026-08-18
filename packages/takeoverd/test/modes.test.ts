// packages/takeoverd/test/modes.test.ts
import { ModeStateMachine, type Mode } from "../src/modes.js";
import { expect, test } from "vitest";

test("defaults to observe", () => {
  expect(new ModeStateMachine().current).toBe("observe");
});
test("shift+ctrl cycles observe -> assist -> full -> observe", () => {
  const m = new ModeStateMachine();
  m.next(); expect(m.current).toBe("assist");
  m.next(); expect(m.current).toBe("full");
  m.next(); expect(m.current).toBe("observe");
});
test("injection flags per mode", () => {
  const m = new ModeStateMachine();
  expect(m.canInject()).toBe(false);          // observe: code-level no injection
  m.set("assist" as Mode);
  expect(m.canInject()).toBe(true);
  expect(m.needsApproval()).toBe(true);       // assist: high-risk needs approval
  m.set("full" as Mode);
  expect(m.needsApproval()).toBe(false);
});
test("set rejects unknown mode", () => {
  expect(() => new ModeStateMachine().set("yolo" as Mode)).toThrow();
});
