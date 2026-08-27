// packages/voiced/test/download-models.test.ts
// The packaged 0.2.18 downloader failed on first run with GNU tar's
// "Cannot connect to C: resolve failed": a bare `C:\...` argument is tar's
// remote host:path syntax when a Git-Bash tar shadows System32 bsdtar on
// PATH, and the extract throw killed the whole run instead of one leg.
// These tests pin both properties: relative-only tar/curl arguments (no
// drive letter can ever reach a tar argv) and per-leg failure isolation.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLeg, LEGS } from "../../../scripts/download-voice-models.mjs";

type Call = { cmd: string; args: string[]; opts: { cwd?: string } };

// a DRIVE letter is a single letter before the colon — `https://x` must not match
const driveLetter = (a: string) => /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(a);

function recordingSpawn(calls: Call[], failOn?: string) {
  return (cmd: string, args: string[], opts: { cwd?: string }) => {
    if (failOn && cmd === failOn) throw Object.assign(new Error("spawn fail"), { status: 2 });
    calls.push({ cmd, args, opts });
    if (cmd === "tar" && opts.cwd) {
      // simulate the extraction: inner dir lands in the spawn cwd; the real
      // fetchLeg then cpSync's it into dest
      mkdirSync(join(opts.cwd, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"), { recursive: true });
      writeFileSync(join(opts.cwd, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "model.int8.onnx"), "x");
    }
  };
}

const leg = LEGS[0]; // sensevoice-asr

describe("download-voice-models path safety + isolation", () => {
  it("tar and curl only ever see RELATIVE filenames (no drive-letter host:path)", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vmdl-"));
    const calls: Call[] = [];
    const ok = await fetchLeg(leg, { dest, spawn: recordingSpawn(calls) });
    expect(ok).toBe(true);
    const tar = calls.find((c) => c.cmd === "tar")!;
    expect(tar).toBeTruthy();
    // the regression: any absolute path in tar argv lets GNU tar read
    // `C:\...` as host `C` — relative names are flavor-proof
    for (const a of tar.args) expect(driveLetter(a)).toBe(false);
    expect(tar.args).toEqual(["-xjf", "m.tar.bz2"]);
    expect(typeof tar.opts.cwd).toBe("string"); // extraction target rides on cwd, not -C
    const curl = calls.find((c) => c.cmd === "curl")!;
    expect(curl.args.some(driveLetter)).toBe(false);
  });

  it("an extract failure is contained to the leg (no throw, returns false)", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vmdl-"));
    const calls: Call[] = [];
    const ok = await fetchLeg(leg, { dest, spawn: recordingSpawn(calls, "tar") });
    expect(ok).toBe(false); // didn't throw — LEGS.map keeps going in main()
  });

  it("a leg whose probe already exists is skipped without spawning", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vmdl-"));
    const outDir = join(dest, ...leg.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, leg.probe), "already");
    const calls: Call[] = [];
    const ok = await fetchLeg(leg, { dest, spawn: recordingSpawn(calls) });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(outDir, leg.probe))).toBe(true);
  });
});
