// packages/takeoverd/test/input.test.ts
import { classifyRisk, InputInjector } from "../src/input.js";
import { ModeStateMachine } from "../src/modes.js";
import { expect, test } from "vitest";

test("plain typing is low risk", () => {
  expect(classifyRisk({ kind: "type", text: "hello world" })).toBe("low");
});
test("enter key is high risk (submits forms)", () => {
  expect(classifyRisk({ kind: "key", key: "Return" })).toBe("high");
});
test("delete-family keys are high risk", () => {
  for (const key of ["Delete", "BackSpace"]) expect(classifyRisk({ kind: "key", key })).toBe("high");
});
test("explicit risk escalation wins", () => {
  expect(classifyRisk({ kind: "move", x: 1, y: 1, risk: "high" })).toBe("high");
});
test("hard-block patterns: rm -rf / sudo in typed text", () => {
  expect(classifyRisk({ kind: "type", text: "rm -rf /home" })).toBe("hard");
  expect(classifyRisk({ kind: "type", text: "sudo rm x" })).toBe("hard");
});
test("typing text containing newline is high risk (xdotool sends real Return)", () => {
  expect(classifyRisk({ kind: "type", text: "line1\nline2" })).toBe("high");
});
test("typing text containing CR or tab is high risk too", () => {
  expect(classifyRisk({ kind: "type", text: "a\rb" })).toBe("high");
  expect(classifyRisk({ kind: "type", text: "col1\tcol2" })).toBe("high");
});
test("combo keys with a high-risk member are high risk", () => {
  expect(classifyRisk({ kind: "key", key: "ctrl+Return" })).toBe("high");
  expect(classifyRisk({ kind: "key", key: "shift+Delete" })).toBe("high");
});
test("exec refuses injection in observe mode", async () => {
  const injector = new InputInjector(new ModeStateMachine()); // boots in observe
  expect(await injector.exec({ kind: "type", text: "hello" })).toBe("blocked-observe");
});
test("exec hard-blocks rm -rf text in assist mode", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // observe -> assist
  const injector = new InputInjector(modes);
  expect(await injector.exec({ kind: "type", text: "rm -rf /home" })).toBe("blocked-hard");
});
test("exec requires approval for Return key in assist mode", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // observe -> assist
  const injector = new InputInjector(modes);
  expect(await injector.exec({ kind: "key", key: "Return" })).toBe("needs-approval");
});
