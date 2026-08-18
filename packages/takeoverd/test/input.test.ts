// packages/takeoverd/test/input.test.ts
import { classifyRisk } from "../src/input.js";
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
