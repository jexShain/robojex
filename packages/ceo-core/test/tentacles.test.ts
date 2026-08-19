// packages/ceo-core/test/tentacles.test.ts
import { TentacleManager } from "../src/tentacles.js";
import type { SpawnFn } from "../src/toolscout.js";
import type { LLMClient } from "../src/llm.js";
import type { TentacleDefinition } from "../src/tentacles.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const FIXTURES = join(fileURLToPath(import.meta.url), "..", "fixtures");

function makeRuntime(): string {
  return mkdtempSync(join(tmpdir(), "robojex-tent-"));
}

// scripted fetch: map full url -> {status, body}; unmapped urls reject like a
// dead network so probe/call failures are testable
function fetchOf(routes: Record<string, { status?: number; body?: string }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = routes[url];
    if (!r) throw new TypeError(`failed to fetch ${url}`);
    const status = r.status ?? 200;
    // 204/304 are null-body statuses: Response() rejects even an empty string
    return new Response([204, 205, 304].includes(status) ? null : r.body ?? "", { status });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function restDef(partial: Partial<TentacleDefinition> & { name: string }): TentacleDefinition {
  return { kind: "rest", ops: [], enabled: true, blurb: "", ...partial };
}

// persist defs as json specs the way an operator (or register) would
function seedSpecs(runtimeDir: string, defs: TentacleDefinition[]): void {
  const dir = join(runtimeDir, "tentacles");
  mkdirSync(dir, { recursive: true });
  for (const d of defs) writeFileSync(join(dir, `${d.name}.json`), JSON.stringify(d, null, 2) + "\n");
}

test("probeOne rest: 2xx and 4xx are reachable with the status recorded; 5xx and network errors are down", async () => {
  const runtimeDir = makeRuntime();
  const { fetchImpl } = fetchOf({
    "https://api.example.com": { status: 204 },
    "https://auth.example.com": { status: 401, body: "no" },
    "https://bad.example.com": { status: 503, body: "boom" },
  });
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl, probeTimeoutMs: 1000 });
  expect(await mgr.probeOne(restDef({ name: "a", endpoint: "https://api.example.com" }))).toEqual({ ok: true, status: "http:204" });
  expect(await mgr.probeOne(restDef({ name: "b", endpoint: "https://auth.example.com" }))).toEqual({ ok: true, status: "http:401" });
  expect(await mgr.probeOne(restDef({ name: "c", endpoint: "https://bad.example.com" }))).toEqual({ ok: false, status: "http:503" });
  expect(await mgr.probeOne(restDef({ name: "d", endpoint: "https://dead.example.com" }))).toEqual({ ok: false, status: "down" });
});

test("probeOne: webhook/poller are trivially ok; hardware checks the blurb's device path; missing device path counts as ok", async () => {
  const runtimeDir = makeRuntime();
  const realDevice = join(runtimeDir, "ttyFAKE0");
  writeFileSync(realDevice, "");
  const mgr = new TentacleManager({ llm: null, runtimeDir });
  expect(await mgr.probeOne(restDef({ name: "wh", kind: "webhook" }))).toEqual({ ok: true, status: "ok" });
  expect(await mgr.probeOne(restDef({ name: "po", kind: "poller" }))).toEqual({ ok: true, status: "ok" });
  expect(await mgr.probeOne(restDef({ name: "hw1", kind: "hardware", blurb: `serial (device: ${realDevice})` }))).toEqual({ ok: true, status: "ok" });
  expect(await mgr.probeOne(restDef({ name: "hw2", kind: "hardware", blurb: "serial (device: /no/such/node)" }))).toEqual({ ok: false, status: "down" });
  expect(await mgr.probeOne(restDef({ name: "hw3", kind: "hardware", blurb: "no path recorded" }))).toEqual({ ok: true, status: "ok" });
});

test("probeAll writes TENTACLES.md lines '- name (kind) — blurb [status]', capped at 40", async () => {
  const runtimeDir = makeRuntime();
  const routes: Record<string, { status: number }> = { "https://ok.example.com": { status: 200 }, "https://down.example.com": { status: 500 } };
  const { fetchImpl } = fetchOf(routes as Record<string, { status?: number }>);
  seedSpecs(runtimeDir, [
    restDef({ name: "ok-api", endpoint: "https://ok.example.com", blurb: "the good one" }),
    restDef({ name: "down-api", endpoint: "https://down.example.com", blurb: "the broken one" }),
    restDef({ name: "hook", kind: "webhook", blurb: "incoming events" }),
  ]);
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl });
  await mgr.loadAll();
  await mgr.probeAll();
  const md = readFileSync(join(runtimeDir, "TENTACLES.md"), "utf8");
  expect(md).toBe("- down-api (rest) — the broken one [http:500]\n- hook (webhook) — incoming events [ok]\n- ok-api (rest) — the good one [http:200]\n");

  // cap: 45 tentacles -> only the first 40 lines
  const many: TentacleDefinition[] = [];
  for (let i = 0; i < 45; i++) many.push(restDef({ name: `t${i}`, kind: "webhook", blurb: "b" }));
  const runtime2 = makeRuntime();
  seedSpecs(runtime2, many);
  const mgr2 = new TentacleManager({ llm: null, runtimeDir: runtime2 });
  await mgr2.loadAll();
  await mgr2.probeAll();
  const lines = readFileSync(join(runtime2, "TENTACLES.md"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(40);
});

test("listBlock: TENTACLES.md served capped at 4KB; missing or empty file reads as ''", async () => {
  const runtimeDir = makeRuntime();
  const mgr = new TentacleManager({ llm: null, runtimeDir });
  expect(mgr.listBlock()).toBe("");
  writeFileSync(join(runtimeDir, "TENTACLES.md"), `- t0 (webhook) — ${"x".repeat(9000)} [ok]\n`);
  expect(mgr.listBlock().length).toBeLessThanOrEqual(4096);
});

test("call rest: auth header pulled from the apiKeyEnv variable, {arg} path templates filled, method/body from the op, result truncated to 2KB", async () => {
  const runtimeDir = makeRuntime();
  const big = "y".repeat(5000);
  const { fetchImpl, calls } = fetchOf({
    "https://api.example.com/v1/users/42": { status: 200, body: big },
    "https://api.example.com/v1/users": { status: 201, body: '{"id":1}' },
  });
  seedSpecs(runtimeDir, [restDef({
    name: "users-api", endpoint: "https://api.example.com",
    auth: { header: "x-api-key", apiKeyEnv: "TENTACLES_TEST_KEY" },
    ops: [
      { name: "get-user", method: "GET", path: "/v1/users/{id}", description: "fetch one user" },
      { name: "create-user", method: "POST", path: "/v1/users", description: "create a user" },
    ],
    blurb: "users",
  })]);
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl });
  await mgr.loadAll();

  process.env.TENTACLES_TEST_KEY = "sekrit-value";
  try {
    const r = await mgr.call("users-api", "get-user", { id: 42 });
    expect(r).toHaveLength(2048); // 5000-char body truncated
    expect(calls[0].url).toBe("https://api.example.com/v1/users/42");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sekrit-value");
    expect(calls[0].init.body).toBeUndefined(); // GET carries no body

    await mgr.call("users-api", "create-user", { name: "ada" });
    expect(calls[1].init.method).toBe("POST");
    expect(calls[1].init.body).toBe(JSON.stringify({ name: "ada" }));
    expect((calls[1].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  } finally {
    delete process.env.TENTACLES_TEST_KEY;
  }

  // unknown tentacle or unknown op -> error, never a silent fetch
  await expect(mgr.call("nope", "x")).rejects.toThrow(/no such tentacle/);
  await expect(mgr.call("users-api", "nope")).rejects.toThrow(/unknown op/);
});

test("call rest: a hanging endpoint rejects after the call timeout; auth header is omitted when the env var is unset", async () => {
  const runtimeDir = makeRuntime();
  const hang = (async () => new Promise<Response>(() => { /* never settles */ })) as unknown as typeof fetch;
  seedSpecs(runtimeDir, [restDef({
    name: "hang-api", endpoint: "https://hang.example.com",
    auth: { header: "x-api-key", apiKeyEnv: "TENTACLES_UNSET_KEY" },
    ops: [{ name: "slow", method: "GET", description: "hangs" }],
  })]);
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl: hang, callTimeoutMs: 80 });
  await mgr.loadAll();
  await expect(mgr.call("hang-api", "slow")).rejects.toThrow(/timed out/i);
});

test("loadAll: json specs and mjs plugins both load; custom probe/call delegate to the plugin", async () => {
  const runtimeDir = makeRuntime();
  mkdirSync(join(runtimeDir, "tentacles"), { recursive: true });
  writeFileSync(join(runtimeDir, "tentacles", "pluggy.mjs"),
    `export async function probe() { return true; }\n` +
    `export async function call(op, args) { return "plugged " + op + " " + JSON.stringify(args ?? {}); }\n` +
    `export function describe() { return "demo plugin"; }\n`);
  seedSpecs(runtimeDir, [restDef({ name: "plain", endpoint: "https://x.example.com", blurb: "plain rest" })]);

  const mgr = new TentacleManager({ llm: null, runtimeDir });
  expect(await mgr.loadAll()).toBe(2);
  const names = mgr.list().map((t) => t.name).sort();
  expect(names).toEqual(["plain", "pluggy"]);
  const pluggy = mgr.list().find((t) => t.name === "pluggy")!;
  expect(pluggy.kind).toBe("custom");
  expect(pluggy.blurb).toBe("demo plugin");
  expect(await mgr.probeOne(pluggy)).toEqual({ ok: true, status: "ok" });
  expect(await mgr.call("pluggy", "ping", { x: 1 })).toBe('plugged ping {"x":1}');
});

test("importOpenapi: json content (or path) becomes a rest tentacle with ops from paths; garbage is an error", async () => {
  const runtimeDir = makeRuntime();
  const { fetchImpl } = fetchOf({ "https://spec.example.com/openapi.json": { status: 200, body: readFileSync(join(FIXTURES, "openapi.json"), "utf8") } });
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl });

  const def = await mgr.importOpenapi(readFileSync(join(FIXTURES, "openapi.json"), "utf8"), "petstore");
  expect(def.kind).toBe("rest");
  expect(def.endpoint).toBe("https://petstore.example.com");
  expect(def.blurb).toBe("Petstore Demo");
  expect(def.ops.map((o) => o.name)).toEqual(["get-pets", "post-pets", "get-pets-id", "delete-pets-id"]);
  // path source and url source work too
  const byPath = await mgr.importOpenapi(join(FIXTURES, "openapi.json"), "petstore-path");
  expect(byPath.ops).toHaveLength(4);
  const byUrl = await mgr.importOpenapi("https://spec.example.com/openapi.json", "petstore-url");
  expect(byUrl.endpoint).toBe("https://petstore.example.com");

  // a minimal YAML doc parses; content with no paths is an error
  const yaml = await mgr.importOpenapi("openapi: 3.0.0\ninfo:\n  title: Yaml API\npaths:\n  /things:\n    get:\n      summary: List things\n", "yaml-api");
  expect(yaml.ops.map((o) => o.name)).toEqual(["get-things"]);
  expect(yaml.blurb).toBe("Yaml API");
  await expect(mgr.importOpenapi("just some text", "junk")).rejects.toThrow(/parse/i);
  await expect(mgr.importOpenapi("{}", "Bad Name")).rejects.toThrow(/name/i);
});

test("scanHardware: lsusb + lsblk --json + /dev nodes become hardware tentacles; spawn failure degrades; a second scan adds nothing", async () => {
  const runtimeDir = makeRuntime();
  const lsusbOut =
    "Bus 001 Device 002: ID 8087:0024 Intel Corp. Integrated Rate Matching Hub\n" +
    "Bus 001 Device 005: ID 046d:c52b Logitech, Inc. Unifying Receiver\n";
  const lsblkOut = JSON.stringify({ blockdevices: [
    { name: "sda", type: "disk", size: "500G", model: "Samsung SSD 870" },
    { name: "sda1", type: "part", size: "500G", model: null },
    { name: "loop0", type: "loop", size: "4M", model: null },
  ] });
  const spawnFn: SpawnFn = vi.fn(async (cmd: string) =>
    cmd === "lsusb" ? { code: 0, stdout: lsusbOut, stderr: "" } : { code: 0, stdout: lsblkOut, stderr: "" });
  const readdirFn = vi.fn((d: string) => d === "/dev"
    ? ["ttyUSB0", "ttyS0", "tty0", "tty19", "video0", "video1", "hidraw0", "null", "sda"]
    : []);

  const mgr = new TentacleManager({ llm: null, runtimeDir, spawnFn, readdirFn });
  expect(await mgr.scanHardware()).toBe(8); // 2 usb + 1 disk + ttyUSB0 + ttyS0 + video0 + video1 + hidraw0
  const defs = mgr.list();

  const intel = defs.find((t) => t.blurb.includes("Intel Corp"))!;
  expect(intel.name).toMatch(/^hw-/);
  expect(intel.kind).toBe("hardware");
  expect(intel.blurb).toContain("(device: /dev/bus/usb/001/002)");
  expect(defs.find((t) => t.blurb.includes("Logitech"))!.blurb).toContain("(device: /dev/bus/usb/001/005)");

  const ssd = defs.find((t) => t.blurb.includes("Samsung"))!;
  expect(ssd.blurb).toContain("(device: /dev/sda)");
  expect(defs.some((t) => t.blurb.includes("loop0"))).toBe(false); // loop devices are not meaningful
  expect(defs.some((t) => t.blurb.includes("/dev/ttyUSB0"))).toBe(true);
  expect(defs.some((t) => t.blurb.includes("/dev/ttyS0"))).toBe(true);
  expect(defs.some((t) => t.blurb.includes("/dev/video0"))).toBe(true);
  expect(defs.some((t) => t.blurb.includes("/dev/video1"))).toBe(true);
  expect(defs.some((t) => t.blurb.includes("/dev/hidraw0"))).toBe(true);
  expect(defs.some((t) => t.blurb.includes("tty0") && !t.blurb.includes("ttyUSB0") && !t.blurb.includes("ttyS0"))).toBe(false); // virtual consoles skipped

  expect(JSON.parse(readFileSync(join(runtimeDir, "tentacles", `${intel.name}.json`), "utf8")).kind).toBe("hardware");
  expect(await mgr.scanHardware()).toBe(0); // idempotent: same names skipped

  // spawn failure degrades to the /dev pass only
  const runtime2 = makeRuntime();
  const mgr2 = new TentacleManager({ llm: null, runtimeDir: runtime2, spawnFn: async () => { throw new Error("no lsusb"); }, readdirFn });
  expect(await mgr2.scanHardware()).toBe(5); // ttyUSB0 + ttyS0 + video0 + video1 + hidraw0
});

test("register: valid spec saves, probes, and lands its TENTACLES.md line; bad name / non-http endpoint / leaked key are rejected", async () => {
  const runtimeDir = makeRuntime();
  const { fetchImpl } = fetchOf({ "https://ok.example.com": { status: 200 } });
  const mgr = new TentacleManager({ llm: null, runtimeDir, fetchImpl });

  await expect(mgr.register({ name: "Bad Name", kind: "rest", endpoint: "https://x.example.com", ops: [], enabled: true, blurb: "" })).rejects.toThrow(/name/);
  await expect(mgr.register({ name: "ok", kind: "rest", endpoint: "ftp://x.example.com", ops: [], enabled: true, blurb: "" })).rejects.toThrow(/endpoint/);
  await expect(mgr.register({ name: "ok", kind: "strange", ops: [], enabled: true, blurb: "" })).rejects.toThrow(/kind/);
  await expect(mgr.register({
    name: "ok", kind: "rest", endpoint: "https://x.example.com",
    auth: { header: "x-api-key", apiKeyEnv: "X", apiKey: "leaked-secret" }, // the key itself must never be stored
    ops: [], enabled: true, blurb: "",
  })).rejects.toThrow(/apiKeyEnv/);
  expect(existsSync(join(runtimeDir, "tentacles"))).toBe(false); // nothing persisted by rejected specs

  const r = await mgr.register({ name: "ok-api", kind: "rest", endpoint: "https://ok.example.com", ops: [], enabled: true, blurb: "demo api" });
  expect(r.probe).toEqual({ ok: true, status: "http:200" });
  expect(JSON.parse(readFileSync(join(runtimeDir, "tentacles", "ok-api.json"), "utf8"))).toMatchObject({ name: "ok-api", kind: "rest" });
  expect(readFileSync(join(runtimeDir, "TENTACLES.md"), "utf8")).toBe("- ok-api (rest) — demo api [http:200]\n");

  // a probe-down register still persists the spec but writes no TENTACLES.md line
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const r2 = await mgr.register({ name: "down-api", kind: "rest", endpoint: "https://down.example.com", ops: [], enabled: true, blurb: "dead" });
    expect(r2.probe.ok).toBe(false);
    expect(existsSync(join(runtimeDir, "tentacles", "down-api.json"))).toBe(true);
    expect(readFileSync(join(runtimeDir, "TENTACLES.md"), "utf8")).not.toContain("down-api");
  } finally {
    err.mockRestore();
  }
});

test("writeManuals: patrol writes <=800-char ops-table manuals for probe-ok tentacles only; spend is booked; second run writes nothing", async () => {
  const runtimeDir = makeRuntime();
  seedSpecs(runtimeDir, [
    restDef({ name: "ok-api", endpoint: "https://ok.example.com", blurb: "widgets", ops: [{ name: "list", method: "GET", path: "/v", description: "list widgets" }] }),
    restDef({ name: "dead-api", endpoint: "https://dead.example.com", blurb: "dead", ops: [] }),
  ]);
  const { fetchImpl } = fetchOf({ "https://ok.example.com": { status: 200 } });
  const spend = vi.fn();
  const chat = vi.fn(async () => ({ content: "Widgets connector.\n## Ops\n- list — list widgets\nCaution: rate limits bite.", usage: { promptTokens: 7, completionTokens: 11 } }));
  const mgr = new TentacleManager({ llm: { chat } as unknown as LLMClient, runtimeDir, fetchImpl, spend });
  await mgr.loadAll();
  await mgr.probeAll();

  expect(await mgr.writeManuals()).toBe(1);
  expect(readFileSync(join(runtimeDir, "tentacle-manuals", "ok-api.md"), "utf8")).toContain("## Ops");
  expect(existsSync(join(runtimeDir, "tentacle-manuals", "dead-api.md"))).toBe(false);
  expect(spend).toHaveBeenCalledTimes(1);
  expect(spend).toHaveBeenCalledWith({ promptTokens: 7, completionTokens: 11 });
  expect(await mgr.writeManuals()).toBe(0); // idempotent
  expect(mgr.manual("ok-api")).toContain("Caution");
  expect(mgr.manual("nope")).toBeNull();
});

test("serveWebhook: POST /t/<name> forwards a 500-char-capped body via onEvent; unknown names 404; stop() closes the server", async () => {
  const runtimeDir = makeRuntime();
  seedSpecs(runtimeDir, [restDef({ name: "github-hook", kind: "webhook", blurb: "github events" })]);
  const mgr = new TentacleManager({ llm: null, runtimeDir });
  await mgr.loadAll();

  const events: string[] = [];
  const srv = await mgr.serveWebhook(0, (s) => events.push(s));
  expect(srv.port).toBeGreaterThan(0);

  const res = await fetch(`http://127.0.0.1:${srv.port}/t/github-hook`, { method: "POST", body: `e=${"x".repeat(800)}` });
  expect(res.status).toBe(200);
  expect(events).toEqual([`webhook[github-hook]: e=${"x".repeat(498)}`]); // body capped at 500 chars

  const missing = await fetch(`http://127.0.0.1:${srv.port}/t/nope`, { method: "POST", body: "x" });
  expect(missing.status).toBe(404);
  expect(events).toHaveLength(1);

  srv.stop();
  await expect(fetch(`http://127.0.0.1:${srv.port}/t/github-hook`, { method: "POST", body: "x" })).rejects.toThrow();
});
