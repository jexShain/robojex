// packages/takeoverd/test/input.test.ts
import { classifyRisk, InputInjector, type InputAction } from "../src/input.js";
import { ModeStateMachine } from "../src/modes.js";
import { expect, test, vi } from "vitest";

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
test("approved exec still refuses injection in observe mode", async () => {
  const injector = new InputInjector(new ModeStateMachine()); // boots in observe
  expect(await injector.exec({ kind: "key", key: "Return" }, true)).toBe("blocked-observe");
});
test("approved exec still hard-blocks rm -rf text", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // observe -> assist
  const injector = new InputInjector(modes);
  expect(await injector.exec({ kind: "type", text: "rm -rf /home" }, true)).toBe("blocked-hard");
});

// --- cross-action keystroke buffer: hard patterns assembled key by key ---
// idle human + stubbed exec: tests never touch a real display
const idleHuman = { idleFn: async () => 60_000, execFn: async () => ({ stdout: "" }) };

test("keystrokes r m space - r f: each alone low, buffered join hits rm -rf", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // observe -> assist
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "space", "-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  // the completing "f" turns the buffered window into "rm -rf" -> hard
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("keystrokes assembling sudo across keys are hard-blocked", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["s", "u", "d"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "o" })).toBe("blocked-hard");
});

test("type appends to the buffer; click/move leave it untouched", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, idleHuman);
  // "rm " arrives as one type action, the dangerous tail as single keys
  expect(await injector.exec({ kind: "type", text: "rm " })).toBe("done");
  expect(await injector.exec({ kind: "click", button: "left" })).toBe("done");
  expect(await injector.exec({ kind: "move", x: 1, y: 1 })).toBe("done");
  for (const key of ["-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("bare modifier combos do not flush the buffer: rm <mods> -rf still blocked", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "space"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  // an attacker hopes modifier presses break the assembled sequence the way
  // any non-key action used to; they contribute nothing and clear nothing
  for (const combo of ["ctrl", "shift+alt", "super"]) {
    expect(await injector.exec({ kind: "key", key: combo })).toBe("done");
  }
  for (const key of ["-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("minus and KP_Subtract aliases both spell the dash in rm -rf", async () => {
  for (const dash of ["minus", "KP_Subtract"]) {
    const modes = new ModeStateMachine();
    modes.next();
    const injector = new InputInjector(modes, idleHuman);
    for (const key of ["r", "m", "space", dash, "r"]) {
      expect(await injector.exec({ kind: "key", key })).toBe("done");
    }
    expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
  }
});

test("BackSpace edits the buffer: a typo fix still assembles rm -rf", async () => {
  const modes = new ModeStateMachine();
  modes.next(); modes.next(); // assist -> full: BackSpace is a high-risk key, skip approval
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "space", "-", "r", "x"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "BackSpace" })).toBe("done"); // drops the x
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("BackSpace on an empty buffer is ignored", async () => {
  const modes = new ModeStateMachine();
  modes.next(); modes.next(); // full: BackSpace needs no approval here
  const injector = new InputInjector(modes, idleHuman);
  expect(await injector.exec({ kind: "key", key: "BackSpace" })).toBe("done");
  for (const key of ["r", "m", "space", "-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("a submitted Return resets the buffer", async () => {
  const modes = new ModeStateMachine();
  modes.next(); modes.next(); // assist -> full: Return executes without approval
  // the window restarts empty: a fresh sudo after the submit is caught whole
  let injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "Return", "s", "u", "d"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "o" })).toBe("blocked-hard");
  // and the pre-submit "rm" cannot join a post-submit tail: no double jeopardy
  injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "Return", "space", "-", "r", "f"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
});

test("a rejected key does not pollute the buffer for later actions", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "space", "-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
  // the refused f left no trace: an ordinary next key still goes through
  expect(await injector.exec({ kind: "key", key: "x" })).toBe("done");
  expect(await injector.exec({ kind: "type", text: "hello" })).toBe("done");
});

test("Delete/KP_Delete never break the window: rm -<Delete>-rf is stopped", async () => {
  const modes = new ModeStateMachine();
  modes.next(); modes.next(); // full: Delete/Return skip approval
  for (const del of ["Delete", "KP_Delete"]) {
    const injector = new InputInjector(modes, idleHuman);
    for (const key of ["r", "m", "space", "-", del, "r"]) {
      expect(await injector.exec({ kind: "key", key })).toBe("done");
    }
    // the completing f assembles "rm -rf": Delete appended nothing, cleared nothing
    expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
    // the refused f left no trace; a following Return submits nothing dangerous
    expect(await injector.exec({ kind: "key", key: "Return" })).toBe("done");
  }
});

test("KP_Space spells the space: rm<KP_Space>-rf is caught", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // assist: every key here is low-risk, no approval needed
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "KP_Space", "-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

test("raw 0x-hex keysyms are unmappable: blocked-hard, window untouched", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, idleHuman);
  for (const key of ["r", "m", "space"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  // 0x2d IS the minus keysym: refusing it fail-closed beats guessing, and
  // caller approval cannot vouch for a name we cannot map
  expect(await injector.exec({ kind: "key", key: "0x2d" })).toBe("blocked-hard");
  expect(await injector.exec({ kind: "key", key: "0x2d" }, true)).toBe("blocked-hard");
  expect(await injector.exec({ kind: "key", key: "ctrl+0x2d" })).toBe("blocked-hard");
  // the refusals left no trace: plain keys still assemble rm -rf afterwards
  for (const key of ["-", "r"]) {
    expect(await injector.exec({ kind: "key", key })).toBe("done");
  }
  expect(await injector.exec({ kind: "key", key: "f" })).toBe("blocked-hard");
});

// --- human preemption in assist mode (xprintidle) ---
test("assist injection is refused while the human is active (idle < 2s)", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const injector = new InputInjector(modes, { idleFn: async () => 500, execFn: async () => ({ stdout: "" }) });
  expect(await injector.exec({ kind: "type", text: "hello" })).toBe("human-active");
});

test("missing xprintidle (ENOENT) skips the preemption check and warns once", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const enoent = async () => {
    const e = new Error("spawn xprintidle ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    throw e;
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const injector = new InputInjector(modes, { idleFn: enoent, execFn: async () => ({ stdout: "" }) });
    expect(await injector.exec({ kind: "type", text: "hello" })).toBe("done");
    expect(await injector.exec({ kind: "type", text: "again" })).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("a failing xprintidle (non-ENOENT) also degrades to skip, warned once", async () => {
  const modes = new ModeStateMachine();
  modes.next();
  const boom = async () => {
    throw new Error("xprintidle timed out after 1000ms");
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const injector = new InputInjector(modes, { idleFn: boom, execFn: async () => ({ stdout: "" }) });
    expect(await injector.exec({ kind: "type", text: "hello" })).toBe("done");
    expect(await injector.exec({ kind: "type", text: "again" })).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("full mode bypasses the human-active check", async () => {
  const modes = new ModeStateMachine();
  modes.next(); modes.next(); // assist -> full
  const injector = new InputInjector(modes, { idleFn: async () => 100, execFn: async () => ({ stdout: "" }) });
  expect(await injector.exec({ kind: "type", text: "hello" })).toBe("done");
});

test("unknown action kind is fail-closed blocked-hard, nothing executed", async () => {
  const modes = new ModeStateMachine();
  modes.next(); // observe -> assist
  const execFn = vi.fn(async () => ({ stdout: "" }));
  const injector = new InputInjector(modes, { idleFn: async () => 60_000, execFn });
  // a kind outside the key/move/click/type union must never reach xdotool
  expect(await injector.exec({ kind: "scroll", x: 1, y: 2 } as unknown as InputAction)).toBe("blocked-hard");
  expect(execFn).not.toHaveBeenCalled();
});
