# CEO Agent 框架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建常驻、自发起、自带元学习的 CEO agent 框架:ceo-core(决策进程)+ takeoverd(桌面接管守护)+ viewer(查看页),子任务无头委派给 hermes/claude-code。

**Architecture:** 三进程隔离。takeoverd 独占端口 :7600,提供截图/phash 事件、键鼠注入、三模式状态机(observe/assist/full)、Shift+Ctrl 全局热键、审批流;ceo-core 事件合并主循环,分层 LLM(patrol/decide)决策,SQLite 任务板,审计器每 20 次决策复盘并改写 RUBRIC/MEMORY(改前在 runtime 内嵌 git 仓库提交快照)。

**Tech Stack:** TypeScript / Node.js ≥20(ESM)、npm workspaces、vitest、ws、better-sqlite3、puppeteer-core(仅 CDP 按需)、外部命令依赖:ImageMagick `import`(截图)、`xdotool`(键鼠)、`xinput test-xi2 --root`(全局热键)、`tesseract`(OCR,可选降级)。

**Spec:** `docs/superpowers/specs/2026-08-18-ceo-agent-framework-design.md`

## Global Constraints

- 项目名 **robojex**(npm 包 `@robojex/*`);API key 只放 runtime/config.json(gitignore),严禁入库
  测试/优化用 DeepSeek 官方:baseUrl `https://api.deepseek.com/v1`,patrol 与 decide 默认 `deepseek-v4-flash`(decide 可在 config 换强模型)
- Node ≥20,ESM(`"type":"module"`),TypeScript strict;所有代码注释英文
- 外部命令缺失时降级不崩溃(OCR 缺失→仅 phash;Chrome 缺失→CDP 工具标记不可用)
- takeoverd 重启回退 observe 模式;观察模式下输入注入通道代码级不注册
- 子 agent 完整输出永不进 CEO 决策上下文,只有压缩后一行摘要
- SQLite 全 WAL;runtime/ 目录整体 gitignore,内嵌独立 git 仓库跟踪 MISSION/RUBRIC/MEMORY 进化史
- 每个包独立可测:vitest 单测;集成测试跑在 Xvfb 上(`xvfb-run -a`)

---

### Task 1: monorepo 脚手架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`(更新)
- Create: `packages/ceo-core/package.json`, `packages/ceo-core/tsconfig.json`
- Create: `packages/takeoverd/package.json`, `packages/takeoverd/tsconfig.json`
- Create: `packages/viewer/package.json`, `packages/viewer/tsconfig.json`

**Interfaces:**
- Produces: npm workspaces 布局;`npm test -ws` 可跑;`@robojex/ceo-core`、`@robojex/takeoverd` 包名

- [ ] **Step 1: 根 package.json + tsconfig + .gitignore**

```json
// package.json
{
  "name": "robojex",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc -b packages/ceo-core packages/takeoverd",
    "test": "vitest run"
  },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "declaration": true, "outDir": "dist", "sourceMap": true,
    "skipLibCheck": true
  }
}
```

```gitignore
# .gitignore 追加
node_modules/
dist/
runtime/
hermes-agent/
```

- [ ] **Step 2: 三个包壳**

```json
// packages/ceo-core/package.json
{ "name": "@robojex/ceo-core", "version": "0.0.1", "type": "module",
  "bin": { "ceo": "dist/index.js" },
  "dependencies": { "ws": "^8.18.0", "better-sqlite3": "^11.0.0" } }
```

```json
// packages/takeoverd/package.json
{ "name": "@robojex/takeoverd", "version": "0.0.1", "type": "module",
  "bin": { "takeoverd": "dist/index.js" },
  "dependencies": { "ws": "^8.18.0", "puppeteer-core": "^23.0.0" } }
```

```json
// packages/viewer/package.json
{ "name": "@robojex/viewer", "version": "0.0.1", "type": "module" }
```

每个包 tsconfig.json 仅 `{ "extends": "../../tsconfig.base.json" }`(viewer 无 TS 源,占位即可)。

- [ ] **Step 3: 冒烟测试验证脚手架**

Create `packages/ceo-core/src/smoke.ts`:
```ts
export const SMOKE = "ceo-core";
```
Create `packages/ceo-core/test/smoke.test.ts`:
```ts
import { SMOKE } from "../src/smoke.js";
import { expect, test } from "vitest";
test("smoke", () => { expect(SMOKE).toBe("ceo-core"); });
```
Run: `npm install && npm test`
Expected: 1 passed

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold with workspaces and vitest"
```

---

### Task 2: ModeStateMachine(takeoverd)

**Files:**
- Create: `packages/takeoverd/src/modes.ts`
- Test: `packages/takeoverd/test/modes.test.ts`

**Interfaces:**
- Produces: `type Mode = "observe" | "assist" | "full";`
  `class ModeStateMachine { get current(): Mode; next(): Mode; set(m: Mode): void; canInject(): boolean; needsApproval(): boolean }`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run packages/takeoverd/test/modes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/takeoverd/test/modes.test.ts` → PASS
```bash
git add -A && git commit -m "feat(takeoverd): mode state machine with safe observe default"
```

---

### Task 3: ScreenPipeline(截图 + pHash + diff 事件)

**Files:**
- Create: `packages/takeoverd/src/screen.ts`
- Test: `packages/takeoverd/test/screen.test.ts`

**Interfaces:**
- Produces: `async function grabGray(w: number, h: number): Promise<Uint8Array>`(经 ImageMagick `import -resize WxH -colorspace gray txt:-` 解析)
  `function phash(g: Uint8Array, size: number): bigint`(32x32 灰度 → DCT → 64bit)
  `function hamming(a: bigint, b: bigint): number`
  `class ScreenPipeline { start(intervalMs: number): void; stop(): void; onEvent(cb: (e: { type: "screen_diff"; hamming: number; ts: number }) => void): void; lastHash(): bigint }`

- [ ] **Step 1: 写失败测试(phash 纯函数部分)**

```ts
// packages/takeoverd/test/screen.test.ts
import { phash, hamming, grabGrayText } from "../src/screen.js";
import { expect, test } from "vitest";

const N = 32;
function flat(v: number): Uint8Array { return new Uint8Array(N * N).fill(v); }

test("identical images -> hamming 0", () => {
  const h1 = phash(flat(128), N), h2 = phash(flat(128), N);
  expect(hamming(h1, h2)).toBe(0);
});
test("different images -> hamming > 0", () => {
  const a = flat(10); const b = flat(200);
  expect(hamming(phash(a, N), phash(b, N))).toBeGreaterThan(0);
});
test("structured vs inverted differs strongly", () => {
  const a = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a[y * N + x] = x * 8;
  const b = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) b[y * N + x] = 255 - x * 8;
  expect(hamming(phash(a, N), phash(b, N))).toBeGreaterThan(10);
});
test("grabGrayText parses ImageMagick txt:- output", () => {
  const txt = "32x32\n0,0: (30%)\n1,0: (50%)\n";
  const g = grabGrayText(txt, 2, 1);
  expect(Array.from(g)).toEqual([77, 128]); // 0.30*255≈77, 0.50*255≈128
});
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/takeoverd/test/screen.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/takeoverd/src/screen.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);

// Parse ImageMagick "txt:-" gray output: "x,y: (NN%)" or "x,y: (NN)" 0-255.
export function grabGrayText(txt: string, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const re = /^(\d+),(\d+):\s*\(([\d.]+)(%?)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    const v = m[4] === "%" ? Math.round(parseFloat(m[3]) * 2.55) : Math.round(parseFloat(m[3]));
    out[Number(m[2]) * w + Number(m[1])] = Math.max(0, Math.min(255, v));
  }
  return out;
}

export async function grabGray(w: number, h: number, display = process.env.DISPLAY): Promise<Uint8Array> {
  // ImageMagick import: capture root window, downscale, grayscale, text dump.
  const { stdout } = await pexec("import", ["-window", "root", "-resize", `${w}x${h}!`, "-colorspace", "gray", "txt:-"], { env: { ...process.env, DISPLAY: display ?? ":0" }, maxBuffer: 1 << 22 });
  return grabGrayText(stdout, w, h);
}

// 32x32 gray -> 2D DCT-II -> top-left 8x8 coeffs (skip DC) -> median threshold -> 64-bit hash
export function phash(g: Uint8Array, n: number): bigint {
  const cos: number[][] = [];
  for (let k = 0; k < 8; k++) { cos[k] = []; for (let x = 0; x < n; x++) cos[k][x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * n)); }
  const coef: number[] = [];
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) s += g[y * n + x] * cos[u][y] * cos[v][x];
    coef.push(s);
  }
  const window = coef.slice(1); // drop DC
  const sorted = [...window].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let h = 0n;
  for (let i = 0; i < 64; i++) if (window[i] > med) h |= 1n << BigInt(63 - i);
  return h;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b, c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

type DiffEvent = { type: "screen_diff"; hamming: number; ts: number };

export class ScreenPipeline {
  private timer: NodeJS.Timeout | null = null;
  private prev: bigint | null = null;
  private last: bigint | null = null;
  private cbs: ((e: DiffEvent) => void)[] = [];
  constructor(private threshold = 10) {}
  onEvent(cb: (e: DiffEvent) => void): void { this.cbs.push(cb); }
  lastHash(): bigint { return this.last ?? 0n; }
  async pollOnce(): Promise<DiffEvent | null> {
    const g = await grabGray(32, 32);
    const h = phash(g, 32);
    this.last = h;
    if (this.prev !== null) {
      const d = hamming(this.prev, h);
      if (d >= this.threshold) {
        const e: DiffEvent = { type: "screen_diff", hamming: d, ts: Date.now() };
        for (const cb of this.cbs) cb(e);
        this.prev = h;
        return e;
      }
    }
    this.prev = h;
    return null;
  }
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => { this.pollOnce().catch(() => {}); }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
```

- [ ] **Step 4: 验证通过** — Run: `npx vitest run packages/takeoverd/test/screen.test.ts` → PASS

- [ ] **Step 5: Xvfb 集成冒烟(手工验证,不进 CI)**

Run: `xvfb-run -a node -e "import('./packages/takeoverd/dist/screen.js').then(async m=>{const g=await m.grabGray(32,32);console.log('gray ok',g.length);console.log('hash',m.phash(g,32))})"`
Expected: `gray ok 1024` + 一个非零 hash
```bash
git add -A && git commit -m "feat(takeoverd): screen pipeline with pHash diff events"
```

---

### Task 4: InputInjector + 高危规则表

**Files:**
- Create: `packages/takeoverd/src/input.ts`
- Test: `packages/takeoverd/test/input.test.ts`

**Interfaces:**
- Produces:
  `type InputAction = { kind: "key" | "move" | "click" | "type"; key?: string; x?: number; y?: number; button?: "left" | "right"; text?: string; risk?: "high" }`
  `function classifyRisk(a: InputAction): "low" | "high"`(规则表:回车提交/删除键/敏感文本/显式 risk:"high" → high)
  `class InputInjector { constructor(modes: ModeStateMachine); async exec(a: InputAction): Promise<"done" | "blocked-observe" | "blocked-hard"> }`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/takeoverd/test/input.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/takeoverd/src/input.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModeStateMachine } from "./modes.js";
const pexec = promisify(execFile);

export type InputAction = {
  kind: "key" | "move" | "click" | "type";
  key?: string; x?: number; y?: number; button?: "left" | "right";
  text?: string; risk?: "high";
};

const HIGH_KEYS = new Set(["Return", "KP_Enter", "Delete", "BackSpace"]);
const HARD_PATTERNS = [/\brm\s+-[rf]{2}/, /\bsudo\b/];

export type Risk = "low" | "high" | "hard";
export function classifyRisk(a: InputAction): Risk {
  if (a.kind === "type" && a.text && HARD_PATTERNS.some((re) => re.test(a.text))) return "hard";
  if (a.risk === "high") return "high";
  if (a.kind === "key" && a.key && HIGH_KEYS.has(a.key)) return "high";
  return "low";
}

export class InputInjector {
  constructor(private modes: ModeStateMachine) {}
  async exec(a: InputAction): Promise<"done" | "blocked-observe" | "blocked-hard" | "needs-approval"> {
    if (!this.modes.canInject()) return "blocked-observe"; // observe: refuse at the gate
    const risk = classifyRisk(a);
    if (risk === "hard") return "blocked-hard";
    if (risk === "high" && this.modes.needsApproval()) return "needs-approval";
    switch (a.kind) {
      case "key": await pexec("xdotool", ["key", a.key!]); break;
      case "move": await pexec("xdotool", ["mousemove", String(a.x), String(a.y)]); break;
      case "click": await pexec("xdotool", ["click", a.button === "right" ? "3" : "1"]); break;
      case "type": await pexec("xdotool", ["type", "--", a.text!]); break;
    }
    return "done";
  }
}
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/takeoverd/test/input.test.ts` → PASS
```bash
git add -A && git commit -m "feat(takeoverd): input injector with risk classification and hard blocks"
```

---

### Task 5: HotkeyWatcher(Shift+Ctrl 全局热键)

**Files:**
- Create: `packages/takeoverd/src/hotkey.ts`
- Test: `packages/takeoverd/test/hotkey.test.ts`

**Interfaces:**
- Produces: `function parseXi2Chunk(chunk: string): { type: "press" | "release"; detail: number }[]`
  `class ComboDetector { feed(e: { type: string; detail: number }): boolean }`(双修饰都按下后都释放且无其他键 → true)
  `class HotkeyWatcher { start(): void; stop(): void; onToggle(cb: () => void): void }`(spawn `xinput test-xi2 --root`)

- [ ] **Step 1: 写失败测试**

```ts
// packages/takeoverd/test/hotkey.test.ts
import { parseXi2Chunk, ComboDetector } from "../src/hotkey.js";
import { expect, test } from "vitest";

test("parses RawKeyPress/RawKeyRelease blocks", () => {
  const chunk = `.RawKeyPress(…) 20:36:01
    detail: 50
  RawKeyRelease(…) 20:36:01
    detail: 50
`;
  const evs = parseXi2Chunk(chunk);
  expect(evs).toEqual([
    { type: "press", detail: 50 },
    { type: "release", detail: 50 },
  ]);
});

test("shift+ctrl press then release with no other key toggles", () => {
  const d = new ComboDetector();
  expect(d.feed({ type: "press", detail: 37 })).toBe(false);  // ctrl down
  expect(d.feed({ type: "press", detail: 50 })).toBe(false);  // shift down (combo armed)
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
  expect(d.feed({ type: "release", detail: 50 })).toBe(true); // both released -> toggle
});

test("other key between press and release cancels", () => {
  const d = new ComboDetector();
  d.feed({ type: "press", detail: 37 });
  d.feed({ type: "press", detail: 50 });
  d.feed({ type: "press", detail: 24 });   // 'q' sneaks in -> cancel
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
  expect(d.feed({ type: "release", detail: 50 })).toBe(false);
});

test("repeats do not double-toggle", () => {
  const d = new ComboDetector();
  d.feed({ type: "press", detail: 50 });
  d.feed({ type: "press", detail: 37 });
  expect(d.feed({ type: "release", detail: 50 })).toBe(false);
  expect(d.feed({ type: "release", detail: 37 })).toBe(true);
  expect(d.feed({ type: "release", detail: 37 })).toBe(false);
});
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/takeoverd/test/hotkey.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/takeoverd/src/hotkey.ts
import { spawn, type ChildProcess } from "node:child_process";

// X keycode: 37=CtrlL 105=CtrlR 50=ShiftL 62=ShiftR
const CTRL = new Set([37, 105]);
const SHIFT = new Set([50, 62]);

export type XiEvent = { type: "press" | "release"; detail: number };

export function parseXi2Chunk(chunk: string): XiEvent[] {
  const out: XiEvent[] = [];
  const re = /RawKey(Press|Release)\([^)]*\)[^\n]*\n\s*detail:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    out.push({ type: m[1] === "Press" ? "press" : "release", detail: Number(m[2]) });
  }
  return out;
}

export class ComboDetector {
  private ctrl = false; private shift = false; private armed = false;
  feed(e: XiEvent): boolean {
    const isCtrl = CTRL.has(e.detail), isShift = SHIFT.has(e.detail);
    if (!isCtrl && !isShift) { // any non-modifier key cancels an armed combo
      if (e.type === "press" && this.armed) { this.ctrl = false; this.shift = false; this.armed = false; }
      return false;
    }
    if (isCtrl) this.ctrl = e.type === "press";
    if (isShift) this.shift = e.type === "press";
    if (this.ctrl && this.shift) this.armed = true;
    if (this.armed && !this.ctrl && !this.shift) { this.armed = false; return true; }
    return false;
  }
}

export class HotkeyWatcher {
  private proc: ChildProcess | null = null;
  private detector = new ComboDetector();
  private cbs: (() => void)[] = [];
  onToggle(cb: () => void): void { this.cbs.push(cb); }
  start(): void {
    this.stop();
    this.proc = spawn("xinput", ["test-xi2", "--root"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (d: string) => {
      buf += d;
      // xinput emits event blocks separated by blank lines
      const blocks = buf.split(/\n\s*\n/);
      buf = blocks.pop() ?? "";
      for (const b of blocks) {
        for (const ev of parseXi2Chunk(b)) {
          if (this.detector.feed(ev)) for (const cb of this.cbs) cb();
        }
      }
    });
    this.proc.on("exit", () => { this.proc = null; });
    this.proc.unref();
  }
  stop(): void { this.proc?.kill("SIGTERM"); this.proc = null; }
}
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/takeoverd/test/hotkey.test.ts` → PASS
```bash
git add -A && git commit -m "feat(takeoverd): global shift+ctrl hotkey via xinput xi2"
```

---

### Task 6: takeoverd WS 服务(信令协议 + 审批流)

**Files:**
- Create: `packages/takeoverd/src/server.ts`
- Test: `packages/takeoverd/test/server.test.ts`

**Interfaces:**
- Consumes: `ModeStateMachine`(Task 2)、`ScreenPipeline`(Task 3)、`InputInjector`(Task 4)、`HotkeyWatcher`(Task 5)
- Produces: WS 消息协议(单端口 :7600):
  - ceo→takeoverd:`{t:"ctrl",op:"input",action:InputAction,id:string}`、`{t:"ctrl",op:"screenshot"}`、`{t:"ctrl",op:"set_mode",mode:Mode}`
  - viewer→takeoverd:`{t:"ctrl",op:"approve",id:string,ok:boolean}`、`{t:"human",text:string}`
  - takeoverd→ceo/viewer 事件:`{t:"evt",type:"screen_diff"|"mode_changed"|"approval",...}`、`{t:"human",text}`
  `class TakeoverServer { constructor(deps); start(port: number): Promise<void>; stop(): Promise<void> }`
  审批:半接模式 high-risk 动作挂起(60s 默认拒),批准后执行

- [ ] **Step 1: 写失败测试**

```ts
// packages/takeoverd/test/server.test.ts
import { TakeoverServer } from "../src/server.js";
import { ModeStateMachine } from "../src/modes.js";
import WebSocket from "ws";
import { expect, test, afterEach } from "vitest";

let server: TakeoverServer | null = null;
afterEach(async () => { await server?.stop(); server = null; });

function connect(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket("ws://127.0.0.1:7601");
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(String(d)))));
}

test("set_mode + input roundtrip; approval flow for high-risk in assist", async () => {
  const modes = new ModeStateMachine();
  server = new TakeoverServer({ modes, port: 7601, injector: null as any, screen: null as any, hotkey: null as any });
  await server.start(7601);
  const ceo = await connect();
  const viewer = await connect();

  ceo.send(JSON.stringify({ t: "ctrl", op: "set_mode", mode: "assist" }));
  const evt = await nextMsg(viewer);
  expect(evt).toMatchObject({ t: "evt", type: "mode_changed", mode: "assist" });

  // high-risk action in assist -> approval request broadcast to viewer
  ceo.send(JSON.stringify({ t: "ctrl", op: "input", id: "r1", action: { kind: "key", key: "Return" } }));
  const appr = await nextMsg(viewer);
  expect(appr).toMatchObject({ t: "evt", type: "approval", id: "r1" });

  viewer.send(JSON.stringify({ t: "ctrl", op: "approve", id: "r1", ok: true }));
  const result = await nextMsg(ceo);
  expect(result).toMatchObject({ t: "evt", type: "input_result", id: "r1" });

  ceo.close(); viewer.close();
});
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/takeoverd/test/server.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/takeoverd/src/server.ts
import { WebSocketServer, WebSocket } from "ws";
import type { ModeStateMachine, Mode } from "./modes.js";
import type { InputInjector, InputAction } from "./input.js";
import type { ScreenPipeline } from "./screen.js";
import type { HotkeyWatcher } from "./hotkey.js";

type Msg = Record<string, any> & { t?: string };

export interface ServerDeps {
  modes: ModeStateMachine;
  injector: InputInjector | null;
  screen: ScreenPipeline | null;
  hotkey: HotkeyWatcher | null;
  port?: number;
  approvalTimeoutMs?: number;
}

export class TakeoverServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private pending = new Map<string, { action: InputAction; timer: NodeJS.Timeout }>();
  constructor(private deps: ServerDeps) {}

  private broadcast(msg: Msg): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  async start(port: number): Promise<void> {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (raw) => { this.handle(ws, JSON.parse(String(raw))).catch(() => {}); });
    });
    this.deps.hotkey?.onToggle(() => {
      this.deps.modes.next();
      this.broadcast({ t: "evt", type: "mode_changed", mode: this.deps.modes.current });
    });
    this.deps.screen?.onEvent((e) => this.broadcast({ t: "evt", ...e }));
    await new Promise<void>((res) => this.wss!.once("listening", res));
  }

  private async handle(ws: WebSocket, m: Msg): Promise<void> {
    if (m.t === "human") { this.broadcast({ t: "human", text: m.text }); return; }
    if (m.t !== "ctrl") return;
    if (m.op === "set_mode") {
      this.deps.modes.set(m.mode as Mode);
      this.broadcast({ t: "evt", type: "mode_changed", mode: m.mode });
      return;
    }
    if (m.op === "approve") {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.ok && this.deps.injector) {
        const r = await this.deps.injector.exec(p.action);
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: r });
      } else {
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: "denied" });
      }
      return;
    }
    if (m.op === "input" && this.deps.injector) {
      const r = await this.deps.injector.exec(m.action as InputAction);
      if (r === "needs-approval") {
        const id: string = m.id ?? crypto.randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.broadcast({ t: "evt", type: "input_result", id, result: "timeout-denied" });
        }, this.deps.approvalTimeoutMs ?? 60_000);
        this.pending.set(id, { action: m.action, timer });
        this.broadcast({ t: "evt", type: "approval", id, action: m.action });
      } else {
        this.broadcast({ t: "evt", type: "input_result", id: m.id, result: r });
      }
      return;
    }
    if (m.op === "screenshot" && this.deps.screen) {
      const g = await import("./screen.js").then((s) => s.grabGray(64, 36));
      this.broadcast({ t: "evt", type: "screenshot_gray", w: 64, h: 36, data: Array.from(g) });
      return;
    }
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    const wss = this.wss; this.wss = null;
    await new Promise<void>((res) => wss?.close(() => res()));
    for (const c of this.clients) c.close();
    this.clients.clear();
  }
}
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/takeoverd/test/server.test.ts` → PASS
```bash
git add -A && git commit -m "feat(takeoverd): ws signaling server with approval flow"
```

---

### Task 7: takeoverd 守护进程入口

**Files:**
- Create: `packages/takeoverd/src/index.ts`
- Create: `packages/takeoverd/src/cdp.ts`(CDP 按需连接,Chrome 缺失降级)

**Interfaces:**
- Produces: `takeoverd` 可执行入口(`node packages/takeoverd/dist/index.js [--port 7600]`);组装全部组件;进程信号处理(SIGTERM 干净退出)

- [ ] **Step 1: 实现 cdp.ts(CDP 通道,失败降级)**

```ts
// packages/takeoverd/src/cdp.ts
// Optional CDP bridge to a local Chrome (--remote-debugging-port=9222).
// Degrades to "unavailable" when Chrome is not running — never crashes the daemon.
export interface CdpChannel {
  available(): Promise<boolean>;
  open(url: string): Promise<string>; // returns page title or error string
  snapshot(): Promise<string>;        // simplified DOM text snapshot
}
export class NullCdp implements CdpChannel {
  async available(): Promise<boolean> { return false; }
  async open(): Promise<string> { return "cdp-unavailable"; }
  async snapshot(): Promise<string> { return "cdp-unavailable"; }
}
export class PuppeteerCdp implements CdpChannel {
  private browser: any = null;
  async available(): Promise<boolean> {
    try {
      const puppeteer = await import("puppeteer-core");
      this.browser = await puppeteer.default.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
      return true;
    } catch { return false; }
  }
  async open(url: string): Promise<string> {
    if (!this.browser) return "cdp-unavailable";
    const page = await this.browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await page.title();
  }
  async snapshot(): Promise<string> {
    if (!this.browser) return "cdp-unavailable";
    const pages = await this.browser.pages();
    const page = pages[pages.length - 1];
    return await page.evaluate(() => document.body?.innerText.slice(0, 4000) ?? "");
  }
}
```

- [ ] **Step 2: 实现 index.ts 组装**

```ts
#!/usr/bin/env node
// packages/takeoverd/src/index.ts
import { ModeStateMachine } from "./modes.js";
import { ScreenPipeline } from "./screen.js";
import { InputInjector } from "./input.js";
import { HotkeyWatcher } from "./hotkey.js";
import { TakeoverServer } from "./server.js";

const port = Number(process.argv.find((a, i, arr) => arr[i - 1] === "--port") ?? 7600);

const modes = new ModeStateMachine();            // boots in observe — safe default
const screen = new ScreenPipeline();
const injector = new InputInjector(modes);
const hotkey = new HotkeyWatcher();
const server = new TakeoverServer({ modes, injector, screen, hotkey, port });

screen.start(1000);                              // observe cadence: 1 fps
hotkey.start();
await server.start(port);
console.log(`takeoverd listening on :${port}, mode=${modes.current}`);

const shutdown = async () => { screen.stop(); hotkey.stop(); await server.stop(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 3: Xvfb 手工冒烟**

Run: `xvfb-run -a node packages/takeoverd/dist/index.js --port 7600 & sleep 2 && echo '{"t":"ctrl","op":"set_mode","mode":"assist"}' | timeout 3 npx wscat -c ws://127.0.0.1:7600 || true`
Expected: 启动日志 `takeoverd listening on :7600, mode=observe`;wscat 收到 mode_changed 事件

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(takeoverd): daemon entry wiring all components"
```

---

### Task 8: LLMClient(OpenAI 兼容 + 双槽 + 记账)

**Files:**
- Create: `packages/ceo-core/src/llm.ts`
- Test: `packages/ceo-core/test/llm.test.ts`

**Interfaces:**
- Produces:
  `interface LlmConfig { baseUrl: string; apiKey: string; patrolModel: string; decideModel: string }`
  `class LLMClient { constructor(cfg: LlmConfig, fetchImpl?: typeof fetch); async chat(slot: "patrol" | "decide", messages: { role: string; content: string }[], opts?: { maxTokens?: number; json?: boolean }): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> }`
  fetchImpl 注入便于测试;失败重试:网络/5xx 指数退避 ×3

- [ ] **Step 1: 写失败测试**

```ts
// packages/ceo-core/test/llm.test.ts
import { LLMClient } from "../src/llm.js";
import { expect, test, vi } from "vitest";

const okBody = JSON.stringify({
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test("chat parses content and usage", async () => {
  const f = vi.fn(async () => new Response(okBody, { status: 200 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("patrol", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
});

test("retries on 5xx then succeeds", async () => {
  let n = 0;
  const f = vi.fn(async () => { if (++n < 3) return new Response("err", { status: 500 }); return new Response(okBody, { status: 200 }); }) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  const r = await c.chat("decide", [{ role: "user", content: "hi" }]);
  expect(r.content).toBe("hello");
  expect(f).toHaveBeenCalledTimes(3);
});

test("throws after 3 consecutive failures", async () => {
  const f = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  const c = new LLMClient({ baseUrl: "http://x/v1", apiKey: "k", patrolModel: "p", decideModel: "d" }, f);
  await expect(c.chat("patrol", [{ role: "user", content: "hi" }])).rejects.toThrow();
});
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/ceo-core/test/llm.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/ceo-core/src/llm.ts
export interface LlmConfig { baseUrl: string; apiKey: string; patrolModel: string; decideModel: string; }
export type Slot = "patrol" | "decide";
export interface ChatMsg { role: string; content: string; }

export class LLMClient {
  constructor(private cfg: LlmConfig, private fetchImpl: typeof fetch = fetch) {}

  async chat(slot: Slot, messages: ChatMsg[], opts: { maxTokens?: number; json?: boolean } = {}):
    Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
    const model = slot === "patrol" ? this.cfg.patrolModel : this.cfg.decideModel;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 2048, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
        });
        if (!res.ok) { if (res.status >= 500) { lastErr = new Error(`llm ${res.status}`); await sleep(2 ** attempt * 200); continue; } throw new Error(`llm ${res.status}: ${await res.text()}`); }
        const j = await res.json() as any;
        return {
          content: j.choices?.[0]?.message?.content ?? "",
          usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 },
        };
      } catch (e) { lastErr = e; await sleep(2 ** attempt * 200); }
    }
    throw lastErr instanceof Error ? lastErr : new Error("llm failed");
  }
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/ceo-core/test/llm.test.ts` → PASS
```bash
git add -A && git commit -m "feat(ceo-core): openai-compatible llm client with dual slots and retry"
```

---

### Task 9: TaskBoard + ContextAssembler

**Files:**
- Create: `packages/ceo-core/src/board.ts`, `packages/ceo-core/src/context.ts`
- Test: `packages/ceo-core/test/board.test.ts`, `packages/ceo-core/test/context.test.ts`

**Interfaces:**
- Produces:
  `interface Task { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; priority: number; assignee: string; attempts: number; resultSummary: string }`
  `class TaskBoard { constructor(dbPath: string); add(t: { title: string; priority?: number; assignee?: string }): Task; list(): Task[]; update(id: string, patch: Partial<Task>): void }`(WAL)
  `class ContextAssembler { build(parts: { mission: string; rubric: string; memory: string; board: Task[]; events: string[]; budgetLine?: string }): string }`(~8K tokens ≈ 32K chars 硬裁剪,优先级:MISSION>RUBRIC>事件>板>MEMORY)

- [ ] **Step 1: 写失败测试**

```ts
// packages/ceo-core/test/board.test.ts
import { TaskBoard } from "../src/board.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("add/list/update roundtrip persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-board-"));
  const b1 = new TaskBoard(join(dir, "board.sqlite"));
  const t = b1.add({ title: "watch site", priority: 5, assignee: "hermes" });
  expect(t.status).toBe("todo");
  b1.update(t.id, { status: "done", resultSummary: "no change 3d" });
  const b2 = new TaskBoard(join(dir, "board.sqlite")); // reopen: persistence
  const list = b2.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ status: "done", resultSummary: "no change 3d" });
});
```

```ts
// packages/ceo-core/test/context.test.ts
import { ContextAssembler } from "../src/context.js";
import { expect, test } from "vitest";

test("assembles sections in order and truncates hard", () => {
  const a = new ContextAssembler();
  const ctx = a.build({
    mission: "MISSION-TEXT", rubric: "RUBRIC-TEXT", memory: "M".repeat(50_000),
    board: [{ id: "t1", title: "task one", status: "todo", priority: 1, assignee: "hermes", attempts: 0, resultSummary: "" }],
    events: ["screen_diff hamming=14", "agent_done t1"],
    budgetLine: "budget: 12000/50000 tokens",
  });
  expect(ctx).toContain("MISSION-TEXT");
  expect(ctx).toContain("RUBRIC-TEXT");
  expect(ctx).toContain("task one");
  expect(ctx).toContain("budget: 12000/50000 tokens");
  expect(ctx.length).toBeLessThanOrEqual(32_000 + 500); // hard cap ~8K tokens
  expect(ctx.indexOf("MISSION-TEXT")).toBeLessThan(ctx.indexOf("RUBRIC-TEXT"));
});
```

- [ ] **Step 2: 验证失败** — Run: `npx vitest run packages/ceo-core/test/board.test.ts packages/ceo-core/test/context.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// packages/ceo-core/src/board.ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Task { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; priority: number; assignee: string; attempts: number; resultSummary: string; }

export class TaskBoard {
  private db: Database.Database;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0, assignee TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, resultSummary TEXT NOT NULL DEFAULT '')`);
  }
  add(t: { title: string; priority?: number; assignee?: string }): Task {
    const task: Task = { id: randomUUID(), title: t.title, status: "todo", priority: t.priority ?? 0, assignee: t.assignee ?? "", attempts: 0, resultSummary: "" };
    this.db.prepare("INSERT INTO tasks VALUES (@id,@title,@status,@priority,@assignee,@attempts,@resultSummary)").run(task);
    return task;
  }
  list(): Task[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, rowid ASC").all() as Task[];
  }
  update(id: string, patch: Partial<Task>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE tasks SET title=@title,status=@status,priority=@priority,assignee=@assignee,attempts=@attempts,resultSummary=@resultSummary WHERE id=@id").run(next);
  }
}
```

```ts
// packages/ceo-core/src/context.ts
import type { Task } from "./board.js";

const HARD_CHAR_CAP = 32_000; // ~8K tokens at 4 chars/token

export class ContextAssembler {
  build(parts: { mission: string; rubric: string; memory: string; board: Task[]; events: string[]; budgetLine?: string }): string {
    const sections: string[] = [];
    sections.push(`# MISSION\n${parts.mission}`);
    sections.push(`# RUBRIC (audit standards)\n${parts.rubric}`);
    sections.push(`# NEW EVENTS SINCE LAST WAKE\n${parts.events.length ? parts.events.join("\n") : "(none)"}`);
    sections.push(`# TASK BOARD\n${parts.board.map((t) => `- [${t.id.slice(0, 8)}] p${t.priority} ${t.status} (${t.assignee || "unassigned"}) ${t.title} :: ${t.resultSummary || "no result yet"}`).join("\n") || "(empty)")}`);
    if (parts.budgetLine) sections.push(`# BUDGET\n${parts.budgetLine}`);
    let out = sections.join("\n\n");
    // memory gets whatever room is left, then hard-truncate everything
    const left = HARD_CHAR_CAP - out.length - 64;
    if (left > 0) out += `\n\n# MEMORY (top)\n${parts.memory.slice(0, left)}`;
    return out.slice(0, HARD_CHAR_CAP);
  }
}
```

- [ ] **Step 4: 验证通过 + 提交**

Run: `npx vitest run packages/ceo-core/test/board.test.ts packages/ceo-core/test/context.test.ts` → PASS
```bash
git add -A && git commit -m "feat(ceo-core): sqlite task board and budgeted context assembler"
```

---

### Task 10: AgentOrchestrator(子 agent 无头编排)

**Files:**
- Create: `packages/ceo-core/src/orchestrator.ts`
- Create: `packages/ceo-core/test/fixtures/stub-agent.sh`
- Test: `packages/ceo-core/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `LLMClient.chat`(压缩结果)
- Produces:
  `type Framework = "hermes" | "claude-code"`
  `class AgentOrchestrator { constructor(opts: { llm: LLMClient | null; runtimeDir: string; maxConcurrent?: number; cmds?: Partial<Record<Framework, string>> }); spawn(fw: Framework, prompt: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; summary: string; logPath: string }>; killAll(): void; reapOrphans(): void }`
  默认命令:`hermes` → `hermes -p "<prompt>" --yolo`;`claude-code` → `claude -p "<prompt>" --dangerously-skip-permissions`

- [ ] **Step 1: stub fixture**

```bash
#!/usr/bin/env bash
# packages/ceo-core/test/fixtures/stub-agent.sh
# Fake sub-agent: prints 300 lines then exits 0.
for i in $(seq 1 300); do echo "line $i: doing fake work"; done
echo "FINAL: stub completed the task successfully"
```
`chmod +x packages/ceo-core/test/fixtures/stub-agent.sh`

- [ ] **Step 2: 写失败测试**

```ts
// packages/ceo-core/test/orchestrator.test.ts
import { AgentOrchestrator } from "../src/orchestrator.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("spawn captures tail, writes full log, summarizes via llm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  let llmInput = "";
  const llm = {
    chat: async (_s: any, msgs: any) => {
      llmInput = msgs[0].content;
      return { content: "stub task done", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  } as any;
  const o = new AgentOrchestrator({ llm, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "do the thing");
  expect(r.exitCode).toBe(0);
  expect(r.summary).toBe("stub task done");
  expect(existsSync(r.logPath)).toBe(true);
  expect(readFileSync(r.logPath, "utf8")).toContain("FINAL: stub completed");
  expect(readFileSync(r.logPath, "utf8")).toContain("line 1:"); // full log, not just tail
  expect(llmInput).toContain("FINAL: stub completed");          // llm sees the tail
});

test("timeout kills stuck agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "sleep 30" } });
  const r = await o.spawn("hermes", "x", { timeoutMs: 500 });
  expect(r.exitCode).not.toBe(0);
  expect(r.summary).toContain("timeout");
});

test("no llm -> raw tail truncated as summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "robojex-orch-"));
  const o = new AgentOrchestrator({ llm: null, runtimeDir: dir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const r = await o.spawn("hermes", "x");
  expect(r.summary.length).toBeGreaterThan(0);
  expect(r.summary.length).toBeLessThanOrEqual(300);
});
```

- [ ] **Step 3: 验证失败** — Run: `npx vitest run packages/ceo-core/test/orchestrator.test.ts` → FAIL

- [ ] **Step 4: 实现**

```ts
// packages/ceo-core/src/orchestrator.ts
import { spawn as pspawn, type ChildProcess } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMClient } from "./llm.js";

export type Framework = "hermes" | "claude-code";
const DEFAULT_CMDS: Record<Framework, (p: string) => string> = {
  "hermes": (p) => `hermes -p ${shq(p)} --yolo`,
  "claude-code": (p) => `claude -p ${shq(p)} --dangerously-skip-permissions`,
};
function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

export interface SpawnResult { exitCode: number; summary: string; logPath: string; }

export class AgentOrchestrator {
  private running = new Map<string, ChildProcess>();
  constructor(private opts: { llm: LLMClient | null; runtimeDir: string; maxConcurrent?: number; cmds?: Partial<Record<Framework, string>> }) {
    mkdirSync(join(this.opts.runtimeDir, "runs"), { recursive: true });
  }

  async spawn(fw: Framework, prompt: string, o: { timeoutMs?: number } = {}): Promise<SpawnResult> {
    const id = randomUUID().slice(0, 8);
    const logPath = join(this.opts.runtimeDir, "runs", `${id}.log`);
    const cmd = this.opts.cmds?.[fw] ?? DEFAULT_CMDS[fw](prompt);
    const full = this.opts.cmds?.[fw] ? `${cmd} ${shq(prompt)}` : cmd;
    return new Promise<SpawnResult>((resolve) => {
      const child = pspawn(full, { shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] });
      this.running.set(id, child);
      let out = "";
      child.stdout!.on("data", (d) => { out += d; });
      child.stderr!.on("data", (d) => { out += d; });
      const timeout = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 30 * 60_000);
      child.on("close", async (code) => {
        clearTimeout(timeout); this.running.delete(id);
        writeFileSync(logPath, out); // full output on disk, never into CEO context
        const tail = out.slice(-2048);
        let summary: string;
        if (this.opts.llm) {
          try {
            const r = await this.opts.llm.chat("patrol", [{ role: "user", content: `Summarize this sub-agent result in ONE line (<=140 chars). If failed, start with FAIL:. Output:\n${tail}` }], { maxTokens: 100 });
            summary = r.content.trim();
          } catch { summary = tail.slice(-140); }
        } else summary = tail.slice(-140);
        resolve({ exitCode: code ?? -1, summary, logPath });
      });
    });
  }

  killAll(): void { for (const [, c] of this.running) c.kill("SIGKILL"); this.running.clear(); }

  reapOrphans(): void {
    // pid ledger written before spawn; kill any whose process no longer has us as ancestor context
    const ledger = join(this.opts.runtimeDir, "pids.json");
    if (!existsSync(ledger)) return;
    let pids: number[] = [];
    try { pids = JSON.parse(readFileSync(ledger, "utf8")); } catch { return; }
    for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    writeFileSync(ledger, "[]");
  }
}
```

- [ ] **Step 5: 验证通过 + 提交**

Run: `npx vitest run packages/ceo-core/test/orchestrator.test.ts` → PASS
```bash
git add -A && git commit -m "feat(ceo-core): sub-agent orchestrator with timeout, logging, llm summary"
```

---

### Task 11: BudgetGovernor + Auditor(预算 + 元学习)

**Files:**
- Create: `packages/ceo-core/src/budget.ts`, `packages/ceo-core/src/auditor.ts`
- Test: `packages/ceo-core/test/budget.test.ts`, `packages/ceo-core/test/auditor.test.ts`

**Interfaces:**
- Produces:
  `class BudgetGovernor { constructor(mode: "burn" | "budgeted", dailyTokens?: number); spend(u: { promptTokens: number; completionTokens: number }): void; gate(): "full" | "patrol-only" | "observe-only"; line(): string; reset(): void }`
  `class Auditor { constructor(opts: { runtimeDir: string; reviewEvery?: number }); record(d: { contextDigest: string; actions: unknown[]; cost: number }): void; due(): boolean; async review(llm: LLMClient): Promise<{ rubricPatch: string; memoryPatch: string; missionNote: string }>; applyPatches(p: { rubricPatch: string; memoryPatch: string }): void }`
  applyPatches:先在 runtime 内嵌 git 仓库提交当前 MISSION/RUBRIC/MEMORY 快照,再追加修订;runtime git 不存在时 `git init`

- [ ] **Step 1: 写失败测试(budget)**

```ts
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
```

- [ ] **Step 2: 写失败测试(auditor)**

```ts
// packages/ceo-core/test/auditor.test.ts
import { Auditor } from "../src/auditor.js";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test } from "vitest";

function runtimeWithFiles() {
  const dir = mkdtempSync(join(tmpdir(), "robojex-audit-"));
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- decide quickly\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  execSync("git init -q", { cwd: dir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: dir });
  return dir;
}

test("records traces, review due at N, patches committed before applied", async () => {
  const dir = runtimeWithFiles();
  const a = new Auditor({ runtimeDir: dir, reviewEvery: 3 });
  expect(a.due()).toBe(false);
  a.record({ contextDigest: "d1", actions: [{ a: 1 }], cost: 10 });
  a.record({ contextDigest: "d2", actions: [{ a: 2 }], cost: 20 });
  expect(a.due()).toBe(false);
  a.record({ contextDigest: "d3", actions: [{ a: 3 }], cost: 30 });
  expect(a.due()).toBe(true);

  const llm = { chat: async () => ({ content: 'RUBRIC PATCH: - prefer cheap actions when idle\nMEMORY PATCH: + hermes stub works', usage: { promptTokens: 0, completionTokens: 0 } }) } as any;
  const patches = await a.review(llm);
  expect(patches.rubricPatch).toContain("RUBRIC PATCH");

  a.applyPatches(patches);
  const rubric = readFileSync(join(dir, "RUBRIC.md"), "utf8");
  expect(rubric).toContain("prefer cheap actions");
  const memory = readFileSync(join(dir, "MEMORY.md"), "utf8");
  expect(memory).toContain("hermes stub works");
  // snapshot committed before mutation — git history has 2+ commits
  const log = execSync("git rev-list --count HEAD", { cwd: dir }).toString().trim();
  expect(Number(log)).toBeGreaterThanOrEqual(2);
  // after review, counter resets
  expect(a.due()).toBe(false);
});
```

- [ ] **Step 3: 验证失败** — Run: `npx vitest run packages/ceo-core/test/budget.test.ts packages/ceo-core/test/auditor.test.ts` → FAIL

- [ ] **Step 4: 实现**

```ts
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
```

```ts
// packages/ceo-core/src/auditor.ts
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { LLMClient } from "./llm.js";

export interface DecisionTrace { contextDigest: string; actions: unknown[]; cost: number; }

export class Auditor {
  private traces: DecisionTrace[] = [];
  constructor(private opts: { runtimeDir: string; reviewEvery?: number }) {}

  record(d: DecisionTrace): void { this.traces.push(d); }
  due(): boolean { return this.traces.length >= (this.opts.reviewEvery ?? 20); }

  async review(llm: LLMClient): Promise<{ rubricPatch: string; memoryPatch: string; missionNote: string }> {
    const rubric = readFileSync(join(this.opts.runtimeDir, "RUBRIC.md"), "utf8");
    const dump = this.traces.map((t, i) => `## decision ${i + 1}\ncontext: ${t.contextDigest}\nactions: ${JSON.stringify(t.actions)}\ncost: ${t.cost}`).join("\n\n");
    const r = await llm.chat("decide", [
      { role: "system", content: "You are the meta-learning auditor. Score past decisions against the RUBRIC. Find recurring low-quality decision patterns. Output EXACTLY three sections:\nRUBRIC PATCH: <new/changed rubric lines to append>\nMEMORY PATCH: <durable facts to append>\nMISSION NOTE: <one line: mission drift observed, or 'none'>" },
      { role: "user", content: `# CURRENT RUBRIC\n${rubric}\n\n# DECISION TRACES\n${dump}` },
    ], { maxTokens: 1500 });
    const c = r.content;
    const grab = (tag: string) => { const m = c.match(new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n[A-Z]{3,} [A-Z]{3,}:|$)`)); return m ? m[1].trim() : ""; };
    this.traces = []; // batch consumed
    return { rubricPatch: grab("RUBRIC PATCH"), memoryPatch: grab("MEMORY PATCH"), missionNote: grab("MISSION NOTE") };
  }

  applyPatches(p: { rubricPatch: string; memoryPatch: string }): void {
    this.snapshotRuntime(); // commit BEFORE mutation — evolution history is recoverable
    if (p.rubricPatch) appendFileSync(join(this.opts.runtimeDir, "RUBRIC.md"), `\n${p.rubricPatch}\n`);
    if (p.memoryPatch) appendFileSync(join(this.opts.runtimeDir, "MEMORY.md"), `\n${p.memoryPatch}\n`);
  }

  private snapshotRuntime(): void {
    const d = this.opts.runtimeDir;
    const git = (args: string) => execSync(`git ${args}`, { cwd: d });
    if (!existsSync(join(d, ".git"))) git("init -q");
    git('-c user.email=ceo@robojex -c user.name=ceo-core add MISSION.md RUBRIC.md MEMORY.md 2>/dev/null || true');
    git('-c user.email=ceo@robojex -c user.name=ceo-core commit -qm "audit snapshot" --allow-empty');
  }
}
```

- [ ] **Step 5: 验证通过 + 提交**

Run: `npx vitest run packages/ceo-core/test/budget.test.ts packages/ceo-core/test/auditor.test.ts` → PASS
```bash
git add -A && git commit -m "feat(ceo-core): budget governor and meta-learning auditor with git snapshots"
```

---

### Task 12: SchedulerLoop(主循环串联)+ 端到端

**Files:**
- Create: `packages/ceo-core/src/loop.ts`
- Create: `packages/ceo-core/src/skills.ts`(说明书加载)
- Create: `skills/hermes.md`, `skills/claude-code.md`
- Test: `packages/ceo-core/test/loop.test.ts`

**Interfaces:**
- Consumes: 前面全部(Task 8/9/10/11)+ takeoverd WS 事件(可选,缺连接时降级纯 CLI)
- Produces:
  `interface LoopDeps { llm: LLMClient; board: TaskBoard; ctx: ContextAssembler; orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor; runtimeDir: string; takeoverUrl?: string }`
  `class SchedulerLoop { constructor(deps: LoopDeps); push(event: string): void; start(tickMs?: number): void; stop(): void; wakeCount(): number }`
  决策协议:patrol 返回 JSON `{"action":"none"|"act"}`;act → decide 返回 JSON `{"actions":[{type:"spawn",framework,prompt,title}|{type:"message",text}|{type:"mission_update",text}|{type:"takeover",input:InputAction}]}`
  端到端测试用假 LLM 脚本化响应 + stub 子 agent,验证 MISSION→决策→spawn→审计→改 RUBRIC 全链

- [ ] **Step 1: skills 说明书(两篇)**

```markdown
<!-- skills/hermes.md -->
# Hermes Agent — usage manual for the CEO

## Invoke (headless, full permission)
hermes -p "<task prompt>" --yolo

## Strengths
- Multi-platform automation (telegram/discord/slack delivery), cron scheduling
- Kanban task graphs with goal-judge + quality gates
- 200+ tools, skills library, memory system

## Weaknesses / failure modes
- First run needs `hermes setup` (interactive) — verify with `hermes --version`
- Webhook/cron features need the gateway daemon, avoid in one-shot mode
- Output can be verbose; rely on the tail, not the head

## When to choose
Platform delivery, scheduled jobs, research with web search, long tool chains.
```

```markdown
<!-- skills/claude-code.md -->
# Claude Code — usage manual for the CEO

## Invoke (headless, full permission)
claude -p "<task prompt>" --dangerously-skip-permissions

## Strengths
- Best-in-class code editing, refactors, multi-file changes
- Strong test debugging and git workflows

## Weaknesses / failure modes
- Requires ANTHROPIC_API_KEY or subscription login; check `claude --version`
- Network filesystems confuse its file watcher — prefer local paths

## When to choose
Any task that edits code: features, bugfixes, refactors, test writing.
```

```ts
// packages/ceo-core/src/skills.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Load one framework manual on demand; CEO never holds all manuals in context.
export function loadSkill(skillsDir: string, fw: string): string {
  const p = join(skillsDir, `${fw}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : `(no manual for ${fw})`;
}
```

- [ ] **Step 2: 写失败端到端测试**

```ts
// packages/ceo-core/test/loop.test.ts
import { SchedulerLoop } from "../src/loop.js";
import { LLMClient } from "../src/llm.js";
import { TaskBoard } from "../src/board.js";
import { ContextAssembler } from "../src/context.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { Auditor } from "../src/auditor.js";
import { BudgetGovernor } from "../src/budget.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { expect, test, vi } from "vitest";

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "robojex-loop-"));
  writeFileSync(join(dir, "MISSION.md"), "Keep the demo repo healthy: run checks, fix failures.\n");
  writeFileSync(join(dir, "RUBRIC.md"), "# RUBRIC\n- prefer cheap actions\n");
  writeFileSync(join(dir, "MEMORY.md"), "# MEMORY\n");
  return dir;
}

test("end to end: mission -> decide -> spawn -> audit -> rubric evolves", async () => {
  const runtimeDir = makeRuntime();
  execSync("git init -q", { cwd: runtimeDir });
  execSync("git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: runtimeDir });

  // scripted fake LLM: patrol says act; decide spawns; audit review returns patches
  let phase = 0;
  const chat = vi.fn(async (slot: string) => {
    if (slot === "patrol") return { content: phase === 0 ? '{"action":"act"}' : '{"action":"none"}', usage: { promptTokens: 10, completionTokens: 2 } };
    // decide slots: first is the decision, then sub-agent summary, then audit review
    phase++;
    if (phase === 1) return { content: JSON.stringify({ actions: [{ type: "spawn", framework: "hermes", title: "stub job", prompt: "run checks" }] }) , usage: { promptTokens: 50, completionTokens: 20 } };
    if (phase === 2) return { content: "stub job finished ok", usage: { promptTokens: 5, completionTokens: 5 } };
    return { content: "RUBRIC PATCH: - verify spawn results before new spawns\nMEMORY PATCH: + stub agent reliable\nMISSION NOTE: none", usage: { promptTokens: 30, completionTokens: 10 } };
  });
  const llm = { chat } as unknown as LLMClient;

  const board = new TaskBoard(join(runtimeDir, "board.sqlite"));
  const orchestrator = new AgentOrchestrator({ llm, runtimeDir, cmds: { hermes: "packages/ceo-core/test/fixtures/stub-agent.sh" } });
  const auditor = new Auditor({ runtimeDir, reviewEvery: 1 });
  const loop = new SchedulerLoop({
    llm, board, ctx: new ContextAssembler(), orchestrator, auditor,
    budget: new BudgetGovernor("burn"), runtimeDir,
  });

  await loop.runOnce("tick");       // patrol=act -> decide=spawn -> stub runs -> summary -> trace recorded
  await loop.runOnce("tick");       // patrol=none -> cheap exit; audit due -> review -> patches applied

  const tasks = board.list();
  expect(tasks.length).toBe(1);
  expect(tasks[0].status).toBe("done");
  expect(readFileSync(join(runtimeDir, "RUBRIC.md"), "utf8")).toContain("verify spawn results");
  expect(readFileSync(join(runtimeDir, "MEMORY.md"), "utf8")).toContain("stub agent reliable");
}, 30_000);
```

- [ ] **Step 3: 验证失败** — Run: `npx vitest run packages/ceo-core/test/loop.test.ts` → FAIL

- [ ] **Step 4: 实现 SchedulerLoop**

```ts
// packages/ceo-core/src/loop.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMClient } from "./llm.js";
import type { TaskBoard } from "./board.js";
import type { ContextAssembler } from "./context.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { Auditor } from "./auditor.js";
import type { BudgetGovernor } from "./budget.js";
import WebSocket from "ws";

export interface LoopDeps {
  llm: LLMClient; board: TaskBoard; ctx: ContextAssembler;
  orchestrator: AgentOrchestrator; auditor: Auditor; budget: BudgetGovernor;
  runtimeDir: string; takeoverUrl?: string;
}

export class SchedulerLoop {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private wakeN = 0;
  private ws: WebSocket | null = null;
  constructor(private d: LoopDeps) {}

  wakeCount(): number { return this.wakeN; }

  push(event: string): void {
    this.queue.push(event);
    // merge events inside a 500ms window into one decision cycle
    if (!this.debounce) {
      this.debounce = setTimeout(() => { this.debounce = null; this.runOnceQueue().catch(() => {}); }, 500);
    }
  }

  private async runOnceQueue(): Promise<void> { const q = this.queue.splice(0); if (q.length) await this.runOnce(q.join("; ")); }

  async runOnce(eventSummary: string): Promise<void> {
    this.wakeN++;
    const gate = this.d.budget.gate();
    if (gate === "observe-only") return; // spend nothing, observe silently
    const read = (f: string) => { try { return readFileSync(join(this.d.runtimeDir, f), "utf8"); } catch { return `(${f} missing)`; } };
    const context = this.d.ctx.build({
      mission: read("MISSION.md"), rubric: read("RUBRIC.md"), memory: read("MEMORY.md"),
      board: this.d.board.list(), events: [eventSummary], budgetLine: this.d.budget.line(),
    });
    // layer 1: cheap patrol triage
    const p = await this.d.llm.chat("patrol", [
      { role: "system", content: "You triage events for an autonomous CEO agent. Reply ONLY JSON: {\"action\":\"none\"} if nothing needs a decision, {\"action\":\"act\"} otherwise." },
      { role: "user", content: context },
    ], { json: true, maxTokens: 20 });
    let triage: any; try { triage = JSON.parse(p.content); } catch { return; }
    if (triage.action !== "act") { await this.maybeAudit(p.usage, []); return; }

    // layer 2: strong decide pass
    const dec = await this.d.llm.chat("decide", [
      { role: "system", content: `You are the CEO of an autonomous agent fleet. Choose actions. Reply ONLY JSON: {"actions":[{"type":"spawn","framework":"hermes"|"claude-code","title":"...","prompt":"..."} | {"type":"message","text":"..."} | {"type":"mission_update","text":"..."} | {"type":"takeover","input":{"kind":"key"|"move"|"click"|"type",...}}]}. Take 0-3 actions. Prefer spawning sub-agents over doing work yourself.` },
      { role: "user", content: context },
    ], { json: true });
    let parsed: any; try { parsed = JSON.parse(dec.content); } catch { parsed = { actions: [] }; }

    for (const a of parsed.actions ?? []) {
      if (a.type === "spawn") {
        const t = this.d.board.add({ title: a.title ?? a.prompt.slice(0, 60), assignee: a.framework });
        this.d.board.update(t.id, { status: "running" });
        const r = await this.d.orchestrator.spawn(a.framework, a.prompt);
        this.d.board.update(t.id, {
          status: r.exitCode === 0 && !r.summary.startsWith("FAIL") ? "done" : "blocked",
          resultSummary: r.summary, attempts: 1,
        });
      } else if (a.type === "mission_update") {
        // audited later via snapshot; write-through allowed for CEO self-edit
        const fs = await import("node:fs");
        fs.writeFileSync(join(this.d.runtimeDir, "MISSION.md"), a.text);
      } else if (a.type === "message") {
        console.log(`[ceo->human] ${a.text}`);
      } else if (a.type === "takeover" && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: "ctrl", op: "input", id: crypto.randomUUID(), action: a.input }));
      }
    }
    await this.maybeAudit({ promptTokens: p.usage.promptTokens + dec.usage.promptTokens, completionTokens: p.usage.completionTokens + dec.usage.completionTokens }, parsed.actions ?? []);
  }

  private async maybeAudit(u: { promptTokens: number; completionTokens: number }, actions: unknown[]): Promise<void> {
    this.d.budget.spend(u);
    this.d.auditor.record({ contextDigest: `wake#${this.wakeN}`, actions, cost: u.promptTokens + u.completionTokens });
    if (this.d.auditor.due()) {
      const patches = await this.d.auditor.review(this.d.llm);
      this.d.auditor.applyPatches(patches);
      if (patches.missionNote && patches.missionNote !== "none") console.log(`[audit] mission note: ${patches.missionNote}`);
    }
  }

  start(tickMs = 60_000): void {
    this.stop();
    if (this.d.takeoverUrl) {
      this.ws = new WebSocket(this.d.takeoverUrl);
      this.ws.on("message", (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m.t === "evt" && m.type === "screen_diff") this.push(`screen_diff hamming=${m.hamming}`);
          if (m.t === "evt" && m.type === "mode_changed") this.push(`mode_changed -> ${m.mode}`);
          if (m.t === "human") this.push(`human: ${m.text}`);
        } catch { /* ignore malformed */ }
      });
      this.ws.on("close", () => { this.ws = null; }); // degrade to pure CLI until reconnect
    }
    this.timer = setInterval(() => this.push("tick"), tickMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.ws?.close(); this.ws = null; if (this.debounce) clearTimeout(this.debounce); this.debounce = null; }
}
```

注意:`runOnce` 是公开方法(测试直接调);`record` 传入真实 actions 需在循环里累积本轮 actions 列表——简化实现中记录 wake 编号与成本,复盘 dump 里 contextDigest 提供 trace 锚点。

- [ ] **Step 5: 验证通过 + 提交**

Run: `npx vitest run packages/ceo-core/test/loop.test.ts` → PASS(30s 超时内)
```bash
git add -A && git commit -m "feat(ceo-core): scheduler loop with event merge, two-tier decisions, meta-learning"
```

---

### Task 13: viewer 查看页 + ceo-core 入口 + 服务安装

**Files:**
- Create: `packages/viewer/index.html`
- Create: `packages/ceo-core/src/index.ts`
- Test: 手工冒烟(此任务以运行验证为主)

**Interfaces:**
- Produces: `ceo` 可执行:读 `runtime/config.json`(llm/预算/takeoverUrl),初始化 runtime 文件与内嵌 git,启动 SchedulerLoop;`--install-service` 生成 systemd unit(ceo + takeoverd 两单元)
  viewer:WS 连 :7600,显示模式徽章、事件流、审批卡(批准/拒绝按钮)、消息输入框

- [ ] **Step 1: viewer 单页**

```html
<!doctype html>
<!-- packages/viewer/index.html -->
<html><head><meta charset="utf-8"><title>robojex viewer</title>
<style>
 body{font-family:system-ui;margin:0;background:#111;color:#eee;display:flex;flex-direction:column;height:100vh}
 #mode{padding:8px 16px;font-weight:bold;font-size:18px}
 .observe{background:#355} .assist{background:#853} .full{background:#833}
 #events{flex:1;overflow-y:auto;padding:8px 16px;font-family:monospace;font-size:12px;white-space:pre-wrap}
 .card{border:1px solid #666;border-radius:6px;padding:8px;margin:6px 0;background:#222}
 .card button{margin-right:8px}
 #send{display:flex;padding:8px}#send input{flex:1;padding:6px}
</style></head><body>
<div id="mode" class="observe">OBSERVE</div>
<div id="events"></div>
<div class="card" id="approval" style="display:none">
  <b>Approval requested</b><div id="appr-action"></div>
  <button onclick="decide(true)">Approve</button><button onclick="decide(false)">Deny</button>
</div>
<div id="send"><input id="msg" placeholder="message to CEO…"><button onclick="sendMsg()">Send</button></div>
<script>
 let ws, pendingId = null;
 const $ = (id) => document.getElementById(id);
 const events = $('events'), mode = $('mode'), approval = $('approval'), apprAction = $('appr-action'), msg = $('msg');
 function log(s){ const d=document.createElement('div'); d.textContent=new Date().toLocaleTimeString()+' '+s; events.prepend(d); }
 function connect(){
   ws = new WebSocket(`ws://${location.hostname}:7600`);
   ws.onopen = ()=>log('connected');
   ws.onclose = ()=>{ log('reconnecting…'); setTimeout(connect, 2000); };
   ws.onmessage = (e)=>{
     let m; try{ m = JSON.parse(e.data); }catch{ return; }
     if(m.t==='evt' && m.type==='mode_changed'){ mode.textContent=m.mode.toUpperCase(); mode.className=m.mode; log('mode -> '+m.mode); }
     else if(m.t==='evt' && m.type==='approval'){ pendingId=m.id; apprAction.textContent=JSON.stringify(m.action); approval.style.display='block'; log('approval: '+JSON.stringify(m.action)); }
     else if(m.t==='evt' && m.type==='input_result'){ approval.style.display='none'; log('input '+m.id+' -> '+m.result); }
     else if(m.t==='evt' && m.type==='screen_diff'){ log('screen_diff hamming='+m.hamming); }
     else if(m.t==='human'){ log('human: '+m.text); }
   };
 }
 function decide(ok){ ws.send(JSON.stringify({t:'ctrl',op:'approve',id:pendingId,ok})); approval.style.display='none'; }
 function sendMsg(){ const v=msg.value.trim(); if(!v)return; ws.send(JSON.stringify({t:'human',text:v})); msg.value=''; }
 connect();
</script></body></html>
```

- [ ] **Step 2: ceo-core 入口**

```ts
#!/usr/bin/env node
// packages/ceo-core/src/index.ts
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { LLMClient } from "./llm.js";
import { TaskBoard } from "./board.js";
import { ContextAssembler } from "./context.js";
import { AgentOrchestrator } from "./orchestrator.js";
import { Auditor } from "./auditor.js";
import { BudgetGovernor } from "./budget.js";
import { SchedulerLoop } from "./loop.js";

const runtimeDir = process.env.ROBOJEX_RUNTIME ?? join(process.cwd(), "runtime");
mkdirSync(join(runtimeDir, "runs"), { recursive: true });

// seed files on first boot
const seed = (f: string, content: string) => { const p = join(runtimeDir, f); if (!existsSync(p)) writeFileSync(p, content); };
seed("MISSION.md", "# MISSION\n(Describe long-term goals here. The CEO evolves this file.)\n");
seed("RUBRIC.md", "# RUBRIC\n- prefer cheap patrol decisions\n- spawn sub-agents instead of doing work inline\n- verify results before marking tasks done\n");
seed("MEMORY.md", "# MEMORY\n");
if (!existsSync(join(runtimeDir, ".git"))) { execSync("git init -q", { cwd: runtimeDir }); execSync("git -c user.email=ceo@robojex -c user.name=ceo add -A && git -c user.email=ceo@robojex -c user.name=ceo commit -qm init", { cwd: runtimeDir }); }

let cfg: any = {};
const cfgPath = join(runtimeDir, "config.json");
if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

if (process.argv.includes("--install-service")) {
  const unit = (name: string, cmd: string) => `[Unit]\nDescription=robojex ${name}\nAfter=network.target\n\n[Service]\nExecStart=${cmd}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
  writeFileSync(join(runtimeDir, "robojex-ceo.service"), unit("ceo", `node ${process.cwd()}/packages/ceo-core/dist/index.js`));
  writeFileSync(join(runtimeDir, "robojex-takeoverd.service"), unit("takeoverd", `node ${process.cwd()}/packages/takeoverd/dist/index.js`));
  console.log(`systemd units written to ${runtimeDir} — copy to ~/.config/systemd/user/ and enable`);
  process.exit(0);
}

const llm = new LLMClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, patrolModel: cfg.patrolModel, decideModel: cfg.decideModel });
const loop = new SchedulerLoop({
  llm, board: new TaskBoard(join(runtimeDir, "board.sqlite")), ctx: new ContextAssembler(),
  orchestrator: new AgentOrchestrator({ llm, runtimeDir }), auditor: new Auditor({ runtimeDir }),
  budget: new BudgetGovernor(cfg.budgetMode ?? "burn", cfg.dailyTokens), runtimeDir,
  takeoverUrl: cfg.takeoverUrl ?? "ws://127.0.0.1:7600",
});
loop.start(cfg.tickMs ?? 60_000);
console.log("ceo-core running (Ctrl+C to stop)");
process.on("SIGINT", () => { loop.stop(); process.exit(0); });
process.on("SIGTERM", () => { loop.stop(); process.exit(0); });
```


`runtime/config.json` 示例(该文件在 gitignore 内,key 严禁入库):

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-REDACTED",
  "patrolModel": "deepseek-v4-flash",
  "decideModel": "deepseek-v4-flash",
  "budgetMode": "budgeted",
  "dailyTokens": 2000000,
  "tickMs": 60000,
  "takeoverUrl": "ws://127.0.0.1:7600"
}
```
- [ ] **Step 3: 全量测试 + 构建 + 手工冒烟**

Run: `npm test` → 全部 PASS
Run: `npm run build` → 无 TS 错误
Run(三个终端):
```bash
xvfb-run -a node packages/takeoverd/dist/index.js --port 7600
ROBOJEX_RUNTIME=/tmp/robojex-demo node packages/ceo-core/dist/index.js   # config.json 填入真实 baseUrl/apiKey 后
python3 -m http.server 8123 -d packages/viewer                   # 浏览器开 http://localhost:8123
```
Expected: viewer 显示 OBSERVE 徽章;CEO 日志显示 tick 唤醒;在 viewer 发消息 → CEO 收到 human 事件

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: viewer page, ceo entrypoint, systemd install"
```

---

## 自审记录

- **Spec 覆盖**:§2 进程契约=Task 6/7/13;§3 主循环=Task 12;§4 三模式=Task 2/4/6(热键 Task 5);§5 编排=Task 10/12+skills(Task 12 Step 1);§6 元学习=Task 11;§7 预算=Task 11;§8 目录=Task 1/13;§9 错误处理=各任务降级路径+Task 13 服务重启;§10 测试=每任务 TDD+Task 12 端到端。CDP(Task 7)为按需增强,OCR 为环境探测降级——与 spec"外部命令缺失时降级"一致。
- **占位符扫描**:无 TBD/TODO;所有代码步骤含完整代码。
- **类型一致性**:`ModeStateMachine.canInject/needsApproval`(Task 2→4→6);`InputAction`(4→6→12 takeover);`LLMClient.chat(slot,messages,opts)`(8→10→11→12);`AgentOrchestrator.spawn(fw,prompt,opts)`(10→12);`Auditor.record/due/review/applyPatches`(11→12)。
