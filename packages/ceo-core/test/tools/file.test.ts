// packages/ceo-core/test/tools/file.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools } from "../../src/tools/file.js";
import type { ToolCtx } from "../../src/tools/registry.js";

let dir: string; let ctx: ToolCtx;
const call = async (name: string, args: Record<string, unknown>) => {
  const e = fileTools().find((t) => t.name === name);
  if (!e) throw new Error(`no tool ${name}`);
  return e.handler(args, ctx);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rjtools-"));
  ctx = { runtimeDir: dir, board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }), skillsDir: dir, takeoverSend: () => {}, chatOut: () => {} };
});

describe("read_file", () => {
  it("returns LINE|CONTENT rows with 1-indexed lines", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    const r = await call("read_file", { path: join(dir, "a.txt") });
    expect(r).toContain("1|hello");
    expect(r).toContain("2|world");
  });
  it("paginates with offset/limit and reports next_offset past the tail", async () => {
    writeFileSync(join(dir, "b.txt"), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const r = await call("read_file", { path: join(dir, "b.txt"), offset: 2, limit: 3 });
    expect(r).toContain("2|l2"); expect(r).toContain("4|l4");
    expect(r).not.toContain("5|l5");
    expect(r).toMatch(/next_offset[=:]?\s*5/i);
  });
  it("binary extension is refused without reading", async () => {
    const r = await call("read_file", { path: join(dir, "x.png") });
    expect(r).toMatch(/binary|refus/i);
  });
  it("truncates giant lines and ensures progress", async () => {
    const giantLine = "x".repeat(150_000); // 150K single line
    writeFileSync(join(dir, "giant.txt"), giantLine + "\nsecond line\n");
    const r = await call("read_file", { path: join(dir, "giant.txt") });
    expect(r).toContain("... [line truncated]");
    expect(r).not.toContain("second line"); // Should stop at first line
    const nextMatch = r.match(/next_offset[=:]?\s*(\d+)/i);
    expect(nextMatch).toBeTruthy();
    const nextOffset = nextMatch ? parseInt(nextMatch[1], 10) : 0;
    expect(nextOffset).toBeGreaterThan(1); // Should advance to line 2
    // Verify we can read from next_offset
    const r2 = await call("read_file", { path: join(dir, "giant.txt"), offset: nextOffset });
    expect(r2).toContain("second line");
  });
});

describe("write_file", () => {
  it("creates parent dirs and overwrites atomically", async () => {
    const p = join(dir, "sub", "c.txt");
    await call("write_file", { path: p, content: "one" });
    await call("write_file", { path: p, content: "two" });
    const r = await call("read_file", { path: p });
    expect(r).toContain("1|two");
  });
});

describe("patch", () => {
  it("replaces a unique old_string and returns a diff summary", async () => {
    const p = join(dir, "d.txt");
    writeFileSync(p, "alpha\nbeta\ngamma\n");
    const r = await call("patch", { mode: "replace", path: p, old_string: "beta", new_string: "BETA" });
    const out = await call("read_file", { path: p });
    expect(out).toContain("BETA");
    expect(r).toMatch(/beta|BETA/); // diff mentions the change
  });
  it("non-unique match without replace_all is an error", async () => {
    const p = join(dir, "e.txt");
    writeFileSync(p, "x\nx\n");
    const r = await call("patch", { mode: "replace", path: p, old_string: "x", new_string: "y" });
    expect(r).toMatch(/unique|multiple|ambiguous/i);
  });
});

describe("search_files", () => {
  it("content mode greps with line numbers", async () => {
    writeFileSync(join(dir, "f1.txt"), "needle here\nplain\n");
    writeFileSync(join(dir, "f2.txt"), "nothing\n");
    const r = await call("search_files", { pattern: "needle", target: "content", path: dir });
    expect(r).toContain("f1.txt");
    expect(r).not.toContain("f2.txt");
  });
  it("files mode globs by name", async () => {
    writeFileSync(join(dir, "g.txt"), "x");
    const r = await call("search_files", { pattern: "*.txt", target: "files", path: dir });
    expect(r).toContain("g.txt");
  });
  it("skips node_modules and .git", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "h.txt"), "needle");
    const r = await call("search_files", { pattern: "needle", target: "content", path: dir });
    expect(r).not.toContain("node_modules");
  });
  it("skips symlinks to avoid loops and duplicates", async () => {
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "needle.txt"), "needle content here");
    symlinkSync(realDir, join(dir, "loop")); // Directory symlink
    symlinkSync(join(realDir, "needle.txt"), join(dir, "link.txt")); // File symlink
    const r = await call("search_files", { pattern: "needle", target: "content", path: dir });
    // Should find the real file once, but not via symlink
    const matches = r.match(/needle\.txt/g);
    expect(matches).toBeTruthy();
    expect(matches?.length).toBe(1); // Only one occurrence, not duplicated
  });
});
