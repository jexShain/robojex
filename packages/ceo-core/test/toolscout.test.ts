// packages/ceo-core/test/toolscout.test.ts
import { ToolScout, SEED_TOOLS } from "../src/toolscout.js";
import type { SpawnFn, WhichFn } from "../src/toolscout.js";
import type { LLMClient } from "../src/llm.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

function makeRuntime(): string {
  return mkdtempSync(join(tmpdir(), "robojex-scout-"));
}

// whichFn that "finds" exactly the given names on a fake PATH
const whichOf = (names: string[]): WhichFn => {
  const set = new Set(names);
  return async (n) => (set.has(n) ? `/fake/bin/${n}` : null);
};

// spawnFn that prints a canned stdout for the given command names
const rawSpawn = (outs: Record<string, string>): SpawnFn =>
  async (cmd: string) => ({ code: 0, stdout: outs[cmd] ?? "", stderr: "" });

test("seed table: ~100 entries, sane names, one-line blurbs, categories covered", () => {
  expect(SEED_TOOLS.length).toBeGreaterThanOrEqual(95);
  expect(SEED_TOOLS.length).toBeLessThanOrEqual(110);
  const categories = new Set<string>();
  for (const t of SEED_TOOLS) {
    expect(t.name).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    expect(t.blurb.length).toBeGreaterThan(10);
    expect(t.blurb).not.toMatch(/\n/);
    expect(Array.isArray(t.verifyArgs)).toBe(true);
    categories.add(t.category);
    if (t.install) expect(Object.keys(t.install).length).toBeGreaterThan(0);
  }
  for (const c of ["system", "text", "media", "network", "data", "dev"]) expect(categories).toContain(c);
  // the explicitly required coverage from the design
  for (const required of ["jq", "yq", "ffmpeg", "convert", "curl", "wget", "git", "python3", "pip", "node", "npm",
    "rg", "fd", "fzf", "bat", "exa", "pandoc", "sqlite3", "yt-dlp", "tesseract", "wkhtmltopdf", "pdftotext",
    "xmllint", "htmlq", "qpdf", "7z", "unzip", "tar", "rsync", "ssh", "nc", "traceroute", "dig", "whois", "openssl", "crontab"]) {
    expect(SEED_TOOLS.some((t) => t.name === required), `missing seed tool ${required}`).toBe(true);
  }
});

test("run: scan + verify write a formatted TOOLS.md, capped at 80 lines", async () => {
  const runtimeDir = makeRuntime();
  const outs: Record<string, string> = {};
  for (const t of SEED_TOOLS) outs[t.name] = `${t.name} 1.2.3\n(c) banners\n`;
  const calls: { cmd: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
  const spawnFn: SpawnFn = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: outs[cmd] ?? "", stderr: "" }; };
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf(SEED_TOOLS.map((t) => t.name)), spawnFn });

  const r = await scout.run();

  expect(r.verified.length).toBeGreaterThan(80);            // seed table big enough to hit the cap
  const lines = readFileSync(join(runtimeDir, "TOOLS.md"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(80);                            // cap holds
  expect(lines[0]).toMatch(/^- \S+ \((system|text|media|network|data|dev)\) — .+ \[v.+\] verified \d{4}-\d{2}-\d{2}$/);
  expect(lines.every((l) => /^- /.test(l))).toBe(true);      // tool lines only, no stray prose
  expect(calls[0]?.opts).toEqual({ timeoutMs: 3000 });       // verify timeout default
  expect(r.pendingInstalls).toEqual([]);                     // everything was "installed"
  expect(r.manualsGenerated).toBe(0);                        // llm null: no manual generation
  expect(existsSync(join(runtimeDir, "tool-manuals", "jq.md"))).toBe(false);
});

test("run: only tools that answer verify land in TOOLS.md; silent ones are dropped", async () => {
  const runtimeDir = makeRuntime();
  // jq + curl + ffmpeg are on PATH; only jq and ffmpeg print a version to stdout
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf(["jq", "curl", "ffmpeg"]), spawnFn: rawSpawn({ jq: "jq-1.7", ffmpeg: "ffmpeg version 6.0" }) });
  const r = await scout.run();
  const md = readFileSync(join(runtimeDir, "TOOLS.md"), "utf8");
  expect(md).toContain("- jq (data) — ");
  expect(md).toContain("[vjq-1.7] verified");
  expect(md).toContain("[vffmpeg version 6.0] verified");
  expect(md).not.toContain("- curl ");                      // found on PATH but verify stayed silent
  expect(r.verified.map((v) => v.name).sort()).toEqual(["ffmpeg", "jq"]);
});

test("verify: first non-empty stdout line truncated to 80 chars; throw or empty yields null", async () => {
  const runtimeDir = makeRuntime();
  const jq = SEED_TOOLS.find((t) => t.name === "jq")!;
  const long = "y".repeat(120);
  const chatty = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: rawSpawn({ jq: `\n\n${long}\nignored tail` }) });
  expect(await chatty.verify(jq)).toBe("y".repeat(80));
  const thrower = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: async () => { throw new Error("ENOENT"); } });
  expect(await thrower.verify(jq)).toBeNull();
  const silent = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: rawSpawn({}) });
  expect(await silent.verify(jq)).toBeNull();
});

test("installMissing: npm/pip items run user-level installs; apt items queue to PENDING_INSTALLS.md and never execute", async () => {
  const runtimeDir = makeRuntime();
  const calls: { cmd: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
  const spawnFn: SpawnFn = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: "", stderr: "" }; };
  // only git is present: every other seed tool counts as missing
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf(["git"]), spawnFn });
  const r = await scout.run();

  expect(calls).toContainEqual({ cmd: "npm", args: ["install", "-g", "pnpm"], opts: { timeoutMs: 60_000 } });
  expect(calls).toContainEqual({ cmd: "npm", args: ["install", "-g", "mongosh"], opts: { timeoutMs: 60_000 } });
  expect(calls).toContainEqual({ cmd: "pip", args: ["install", "--user", "yq"], opts: { timeoutMs: 60_000 } });
  expect(calls).toContainEqual({ cmd: "pip", args: ["install", "--user", "yt-dlp"], opts: { timeoutMs: 60_000 } });
  expect(calls.filter((c) => c.cmd === "apt")).toEqual([]);   // system packages are never spawned

  const pending = readFileSync(join(runtimeDir, "PENDING_INSTALLS.md"), "utf8");
  expect(pending).toMatch(/^- ffmpeg \(for ffmpeg/m);
  expect(pending).toMatch(/^- tesseract-ocr \(for tesseract/m);
  expect(r.pendingInstalls).toContain("ffmpeg");
  expect(r.pendingInstalls).toContain("tesseract-ocr");
});

test("installMissing: apt queue is idempotent — a second run appends nothing", async () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf(["git"]), spawnFn: rawSpawn({ git: "git version 2.40" }) });
  await scout.run();
  await scout.run();
  const pending = readFileSync(join(runtimeDir, "PENDING_INSTALLS.md"), "utf8");
  expect(pending.match(/^- ffmpeg /gm)).toHaveLength(1);      // queued once, not duplicated
});

test("writeManuals: fake LLM writes one <=800-char manual per verified tool; second run regenerates nothing", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async () => ({
    content: `Purpose: JSON wrangling.\n## Common commands\n- jq . f.json\n- jq '.a[]' f.json\n- jq -s . f.json\nCaution: slurps whole files into memory. ${"z".repeat(900)}`,
    usage: { promptTokens: 1, completionTokens: 1 },
  }));
  const scout = new ToolScout({
    llm: { chat } as unknown as LLMClient, runtimeDir,
    whichFn: whichOf(["jq", "rg"]), spawnFn: rawSpawn({ jq: "jq-1.7", rg: "ripgrep 14.0.0" }),
  });

  const r1 = await scout.run();
  expect(r1.manualsGenerated).toBe(2);
  const txt = readFileSync(join(runtimeDir, "tool-manuals", "jq.md"), "utf8");
  expect(txt).toContain("Purpose: JSON wrangling.");
  expect(txt.length).toBeLessThanOrEqual(800);                // hard cap even though the LLM overshot
  expect(readFileSync(join(runtimeDir, "tool-manuals", "rg.md"), "utf8").length).toBeLessThanOrEqual(800);
  expect(chat).toHaveBeenCalledTimes(2);                      // patrol slot, one call per manual

  const r2 = await scout.run();                               // idempotent: manuals exist
  expect(r2.manualsGenerated).toBe(0);
  expect(chat).toHaveBeenCalledTimes(2);
});

test("readToolsBlock: truncated to 4KB; missing file yields empty string", () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: rawSpawn({}) });
  expect(scout.readToolsBlock()).toBe("");
  writeFileSync(join(runtimeDir, "TOOLS.md"), "x".repeat(6000));
  expect(scout.readToolsBlock()).toHaveLength(4096);
});

test("verifiedNames/readManual: names parsed from TOOLS.md; manuals read back only when present", () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: rawSpawn({}) });
  writeFileSync(join(runtimeDir, "TOOLS.md"),
    "- jq (data) — JSON processor [vjq-1.7] verified 2026-01-01\n- ffmpeg (media) — av tools [v6] verified 2026-01-01\n");
  expect(scout.verifiedNames()).toEqual(["jq", "ffmpeg"]);
  mkdirSync(join(runtimeDir, "tool-manuals"), { recursive: true });
  writeFileSync(join(runtimeDir, "tool-manuals", "jq.md"), "manual body");
  expect(scout.readManual("jq")).toBe("manual body");
  expect(scout.readManual("ffmpeg")).toBeNull();              // no file written yet
});

test("run: a call while a pass is in flight returns the last report (or empty) instead of re-scanning", async () => {
  const runtimeDir = makeRuntime();
  let gate1: () => void = () => {};
  let gate2: () => void = () => {};
  const g1 = new Promise<void>((r) => { gate1 = r; });
  const g2 = new Promise<void>((r) => { gate2 = r; });
  // gating the FIRST seed (crontab) makes the hang land before run() even
  // returns, so busy-state assertions stay deterministic
  let crontabAsks = 0;
  const whichFn: WhichFn = async (n) => {
    if (n === "jq") return "/fake/bin/jq";
    if (n === "crontab") {
      crontabAsks++;
      await (crontabAsks === 1 ? g1 : g2); // pass 1 hangs in scan(), pass 3 too
    }
    return null;
  };
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn, spawnFn: rawSpawn({ jq: "jq-1.7" }) });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = scout.run();
    const second = await scout.run();  // busy: immediate empty report, no scan
    expect(second).toEqual({ verified: [], manualsGenerated: 0, pendingInstalls: [] });
    expect(warn).toHaveBeenCalledTimes(1);

    gate1();
    const r1 = await first;
    expect(r1.verified.map((v) => v.name)).toEqual(["jq"]);

    const third = scout.run();          // free again: a fresh pass starts and hangs
    const fourth = await scout.run();   // busy again: the previous report comes back
    expect(fourth).toEqual(r1);
    expect(crontabAsks).toBe(2);        // the busy returns never reached scan()
    expect(warn).toHaveBeenCalledTimes(2);

    gate2();
    expect((await third).verified.map((v) => v.name)).toEqual(["jq"]);
  } finally {
    warn.mockRestore();
  }
});

test("writeManuals: every manual LLM call is booked through the spend hook", async () => {
  const runtimeDir = makeRuntime();
  const spent: { promptTokens: number; completionTokens: number }[] = [];
  const chat = vi.fn(async () => ({
    content: "Purpose: JSON wrangling.\n## Common commands\n- jq . f.json\n- jq '.a[]' f.json\n- jq -s . f.json\nCaution: slurps whole files.",
    usage: { promptTokens: 3, completionTokens: 4 },
  }));
  const scout = new ToolScout({
    llm: { chat } as unknown as LLMClient, runtimeDir,
    whichFn: whichOf(["jq", "rg"]), spawnFn: rawSpawn({ jq: "jq-1.7", rg: "ripgrep 14.0.0" }),
    spend: (u) => spent.push({ ...u }),
  });

  const r = await scout.run();

  expect(r.manualsGenerated).toBe(2);
  expect(chat).toHaveBeenCalledTimes(2);                    // one patrol call per manual
  expect(spent).toHaveLength(2);                            // and each one is booked
  expect(spent).toEqual([{ promptTokens: 3, completionTokens: 4 }, { promptTokens: 3, completionTokens: 4 }]);
});

test("run(query): LLM-extracted candidates verify and land in TOOLS.md; seed dupes and bad names are dropped", async () => {
  const runtimeDir = makeRuntime();
  const chat = vi.fn(async (_slot: string, msgs: { role: string; content: string }[]) => {
    const user = String(msgs[1]?.content ?? "");
    if (user.startsWith("Task:")) {
      return { content: '{"names":["jq", "not a tool!", "newtool", "jq"]}', usage: { promptTokens: 5, completionTokens: 6 } };
    }
    if (user.includes("one sentence")) {
      return { content: "newtool slices and dices JSON streams.", usage: { promptTokens: 2, completionTokens: 3 } };
    }
    return { content: "Purpose: JSON wrangling.\n## Common commands\n- newtool a\n- newtool b\n- newtool c\nCaution: sharp edges.", usage: { promptTokens: 2, completionTokens: 3 } };
  });
  const scout = new ToolScout({
    llm: { chat } as unknown as LLMClient, runtimeDir,
    whichFn: whichOf(["jq", "newtool"]), spawnFn: rawSpawn({ jq: "jq-1.7", newtool: "newtool 0.1" }),
  });

  const r = await scout.run("slice JSON out of API dumps");

  const md = readFileSync(join(runtimeDir, "TOOLS.md"), "utf8");
  expect(md.match(/^- jq /gm)).toHaveLength(1);  // jq came back from the LLM too: seed line wins, no duplicate
  expect(md).toContain("- newtool (system) — newtool slices and dices JSON streams. [vnewtool 0.1] verified");
  expect(r.verified.map((v) => v.name).sort()).toEqual(["jq", "newtool"]);
  expect(readFileSync(join(runtimeDir, "tool-manuals", "newtool.md"), "utf8")).toContain("Purpose: JSON wrangling.");
});

test("run(query): extraction failure or garbage JSON degrades to the plain seed pass", async () => {
  const runtimeDir = makeRuntime();
  const down = vi.fn(async (_slot: string, msgs: { role: string; content: string }[]) => {
    if (String(msgs[1]?.content ?? "").startsWith("Task:")) throw new Error("llm down");
    return { content: "Purpose: JSON wrangling.\n## Common commands\n- jq . f.json\n- jq '.a[]' f.json\n- jq -s . f.json\nCaution: slurps.", usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const scout = new ToolScout({ llm: { chat: down } as unknown as LLMClient, runtimeDir, whichFn: whichOf(["jq"]), spawnFn: rawSpawn({ jq: "jq-1.7" }) });
  const r = await scout.run("anything");
  expect(r.verified.map((v) => v.name)).toEqual(["jq"]);
  expect(readFileSync(join(runtimeDir, "TOOLS.md"), "utf8")).toContain("- jq (data) — ");

  const garbage = new ToolScout({
    llm: { chat: vi.fn(async () => ({ content: "not json at all", usage: { promptTokens: 1, completionTokens: 1 } })) } as unknown as LLMClient,
    runtimeDir: makeRuntime(), whichFn: whichOf(["jq"]), spawnFn: rawSpawn({ jq: "jq-1.7" }),
  });
  expect((await garbage.run("anything")).verified.map((v) => v.name)).toEqual(["jq"]);
});

test("verify: empty stdout falls back to the first non-empty stderr line (nc-style probes)", async () => {
  const runtimeDir = makeRuntime();
  const nc = SEED_TOOLS.find((t) => t.name === "nc")!;
  const scout = new ToolScout({
    llm: null, runtimeDir, whichFn: whichOf([]),
    spawnFn: async () => ({ code: 1, stdout: "", stderr: "\nOpenBSD netcat (Debian)\nusage: nc [-46DdFhlnrstkUvzC]" }),
  });
  expect(await scout.verify(nc)).toBe("OpenBSD netcat (Debian)");
});

test("readToolsBlock: whitespace-only TOOLS.md reads as empty", () => {
  const runtimeDir = makeRuntime();
  const scout = new ToolScout({ llm: null, runtimeDir, whichFn: whichOf([]), spawnFn: rawSpawn({}) });
  writeFileSync(join(runtimeDir, "TOOLS.md"), "  \n\n\t \n");
  expect(scout.readToolsBlock()).toBe("");
});
