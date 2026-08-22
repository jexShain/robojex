// packages/ceo-core/test/tools/jobs.test.ts
// jobs tools — start-and-poll semantics: job_start must never block, output
// harvests on later cycles, kill is a cascade, and the live cap holds.
// The registry is a process-level singleton, so these tests share state in
// declaration order (vitest runs `it` top-to-bottom within a file).
import { describe, it, expect, afterAll } from "vitest";
import { jobsTools } from "../../src/tools/jobs.js";
import type { ToolCtx } from "../../src/tools/registry.js";

const ctx: ToolCtx = {
  runtimeDir: "/tmp", board: {} as never, spawn: async () => ({ exitCode: 0, summary: "" }),
  skillsDir: "/tmp", takeoverSend: () => {}, chatOut: () => {},
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const e = jobsTools().find((t) => t.name === name);
  if (!e) throw new Error(`no tool ${name}`);
  return e.handler(args, ctx);
};
const startedId = (r: string) => r.match(/job (\S+) started/)?.[1] ?? "";
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
const unix = process.platform !== "win32";
const unixIt = unix ? it : it.skip;
const sleepCmd = (s: number) => (unix ? `sleep ${s}; echo done` : `powershell -Command "Start-Sleep ${s}; echo done"`);

describe("jobs", () => {
  let slowJob = ""; // sleep 2; echo done — finishes between tests 1 and 2

  unixIt("job_start returns immediately (<1s) with an id; job_output sees [still running", async () => {
    const t0 = Date.now();
    const r = await call("job_start", { command: sleepCmd(2) });
    expect(Date.now() - t0).toBeLessThan(1000);
    slowJob = startedId(r);
    expect(slowJob).toMatch(/^[0-9a-f]{8}$/);
    const out = await call("job_output", { id: slowJob });
    expect(out).toContain(`$ ${sleepCmd(2)}`);
    expect(out).toContain("[still running");
  }, 15000);

  unixIt("finished job reports [exit 0] and output tail; id prefix works", async () => {
    await wait(3000); // job runs 2s; give close a comfortable margin
    const out = await call("job_output", { id: slowJob });
    expect(out).toContain("[exit 0]");
    expect(out).toContain("done");
    const byPrefix = await call("job_output", { id: slowJob.slice(0, 6) });
    expect(byPrefix).toBe(out);
  }, 15000);

  unixIt("job_kill terminates a long sleep within 3s and claims exit -9", async () => {
    const kid = startedId(await call("job_start", { command: sleepCmd(30) }));
    const t0 = Date.now();
    const k = await call("job_kill", { id: kid });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(k).toBe(`job ${kid} killed (exit -9)`);
    const out = await call("job_output", { id: kid });
    expect(out).toContain("killed");
    const again = await call("job_kill", { id: kid });
    expect(again).toBe(`job ${kid} already exited (-9)`);
  }, 15000);

  unixIt("job_list shows ids, states and commands; live jobs first", async () => {
    const rid = startedId(await call("job_start", { command: sleepCmd(10) })); // a live one for ordering
    const list = await call("job_list");
    expect(list).toContain(slowJob);
    expect(list).toContain("done(0)");
    expect(list).toContain("killed");
    expect(list.indexOf("running")).toBeLessThan(list.indexOf("done(")); // live first
    expect(list).toContain(sleepCmd(2).slice(0, 60));
    await call("job_kill", { id: rid }); // release the slot for the cap test
  }, 15000);

  unixIt("concurrency cap: the 7th live job is refused", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await call("job_start", { command: sleepCmd(30) });
      expect(r).toMatch(/started \(pid \d+\)/);
    }
    const r = await call("job_start", { command: sleepCmd(30) });
    expect(r).toMatch(/error: 6 live jobs already running/);
  }, 15000);

  it("validation: command required, timeout integer-bounded, unknown ids error (no throw)", async () => {
    await expect(call("job_start", {})).resolves.toMatch(/command \(string\) required/);
    await expect(call("job_start", { command: "echo hi", timeout: 2.5 })).resolves.toMatch(/positive integer/);
    await expect(call("job_start", { command: "echo hi", timeout: 99999 })).resolves.toMatch(/3600/);
    await expect(call("job_output", { id: "deadbeef" })).resolves.toMatch(/no job 'deadbeef'/);
    await expect(call("job_kill", { id: "deadbeef" })).resolves.toMatch(/no job 'deadbeef'/);
  });

  afterAll(async () => {
    // leave nothing behind: kill whatever is still running
    const list = await call("job_list");
    for (const line of list.split("\n")) {
      const id = line.split(/\s+/)[0] ?? "";
      if (/^[0-9a-f]{8}$/.test(id) && line.includes("running")) await call("job_kill", { id });
    }
  });
});
