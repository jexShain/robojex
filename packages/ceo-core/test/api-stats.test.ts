// packages/ceo-core/test/api-stats.test.ts — GET /api/stats, the read side of
// the R8 experience ledger: aggregateStats folds runtime/STATS.md tail lines
// (`framework|verdict|title`, written by the loop's appendStat) into a
// per-agent track record — counts, pass rate, the 3 most recent titles.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiServer } from "../src/api.js";
import { aggregateStats, type AgentStat } from "../src/stats.js";
import { TaskBoard } from "../src/board.js";
import { BudgetGovernor } from "../src/budget.js";

describe("aggregateStats (pure)", () => {
  it("folds a multi-line ledger into per-agent counts, pass rates and recent titles, busiest first", () => {
    const raw = [
      "hermes|pass|整理下载文件夹",
      "hermes|fail|修复构建脚本",
      "hermes|pass|扫描收件箱",
      "claude-code|pass|写周报",
      "opencode|partial|升级依赖",
    ].join("\n") + "\n";
    const agents = aggregateStats(raw);
    expect(agents).toEqual([
      { framework: "hermes", total: 3, pass: 2, partial: 0, fail: 1, passRate: 67, recent: ["整理下载文件夹", "修复构建脚本", "扫描收件箱"] },
      { framework: "claude-code", total: 1, pass: 1, partial: 0, fail: 0, passRate: 100, recent: ["写周报"] }, // 1-1 tie → name asc
      { framework: "opencode", total: 1, pass: 0, partial: 1, fail: 0, passRate: 0, recent: ["升级依赖"] },
    ]);
  });

  it("caps recent at the agent's last 3 titles in ledger order", () => {
    const raw = ["t0", "t1", "t2", "t3", "t4"].map((t) => `hermes|pass|${t}`).join("\n") + "\n";
    expect(aggregateStats(raw)).toEqual([
      { framework: "hermes", total: 5, pass: 5, partial: 0, fail: 0, passRate: 100, recent: ["t2", "t3", "t4"] },
    ]);
  });

  it("skips bad lines (no pipe, empty framework/verdict) but keeps counting the rest; unknown verdicts add no count", () => {
    const raw = [
      "not a stat line",
      "hermes|pass|ok job",
      "|pass|ghost agent",
      "hermes|bogus|unknown verdict job",
      "hermes||no verdict",
      "hermes|fail",
    ].join("\n") + "\n";
    expect(aggregateStats(raw)).toEqual([
      // 5 lines mention hermes: pass counted, bogus counts nothing (title kept),
      // empty verdict skipped, missing title line still counts
      { framework: "hermes", total: 2, pass: 1, partial: 0, fail: 1, passRate: 50, recent: ["ok job", "unknown verdict job"] },
    ]);
  });

  it("aggregates only the last 200 ledger lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 205; i++) lines.push(`hermes|pass|t${i}`);
    const agents = aggregateStats(lines.join("\n") + "\n");
    expect(agents[0]!.total).toBe(200);
    expect(agents[0]!.recent).toEqual(["t202", "t203", "t204"]); // t0..t4 fell out of the window
  });

  it("empty or pipe-free input → []", () => {
    expect(aggregateStats("")).toEqual([]);
    expect(aggregateStats("no pipes here\nnone at all\n")).toEqual([]);
  });
});

// -- HTTP surface -------------------------------------------------------------

const servers: ApiServer[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function makeApi(): { api: ApiServer; runtimeDir: string } {
  const runtimeDir = mkdtempSync(join(tmpdir(), "robojex-stats-"));
  const api = new ApiServer({
    port: 0,
    board: new TaskBoard(join(runtimeDir, "board.sqlite")),
    budget: new BudgetGovernor("burn"),
    runtimeDir,
    loop: { push: () => {} },
  });
  servers.push(api);
  return { api, runtimeDir };
}

describe("GET /api/stats", () => {
  it("aggregates runtime/STATS.md into { agents: [...] }", async () => {
    const { api, runtimeDir } = makeApi();
    writeFileSync(join(runtimeDir, "STATS.md"), "hermes|pass|a\nhermes|fail|b\nclaude-code|pass|c\n");
    await api.start();
    const res = await fetch(`http://127.0.0.1:${api.port}/api/stats`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agents: [
        { framework: "hermes", total: 2, pass: 1, partial: 0, fail: 1, passRate: 50, recent: ["a", "b"] },
        { framework: "claude-code", total: 1, pass: 1, partial: 0, fail: 0, passRate: 100, recent: ["c"] },
      ] as AgentStat[],
    });
  });

  it("missing ledger → 200 { agents: [] } (no record yet is ordinary state)", async () => {
    const { api } = makeApi();
    await api.start();
    const res = await fetch(`http://127.0.0.1:${api.port}/api/stats`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
  });
});
