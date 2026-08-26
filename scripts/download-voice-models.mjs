#!/usr/bin/env node
// scripts/download-voice-models.mjs — cross-platform model fetcher for the
// voiced daemon (Windows first-class: the sidecar keeps its 2GB model trees
// in %APPDATA%/RoboJex/voiced-models, and tar.exe on Win10+ is bsdtar, which
// reads .tar.bz2 natively). Idempotent: a leg whose model file already exists
// is skipped. Primary: github releases; fallback: hf-mirror.
//
// Usage: node download-voice-models.mjs [destDir]
//   destDir default: packages/voiced/models (repo-relative) — pass the same
//   dir you give voiced's --models / VOICED_MODELS_DIR.
//
// Path-safety rule (learned the hard way on the packaged 0.2.18): a bare
// `C:\...` argument is GNU tar's remote `host:path` syntax ("Cannot connect
// to C: resolve failed") when a Git-Bash/MSYS tar shadows System32 bsdtar on
// PATH. Every child therefore runs with cwd = the temp dir and RELATIVE
// filenames — no drive letter can appear in any tar argument, for any tar
// flavor, ever.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LEGS = [
  {
    name: "sensevoice-asr",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
    inner: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    out: ["asr", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"],
    probe: "model.int8.onnx",
  },
  {
    name: "kokoro-tts",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
    inner: "kokoro-multi-lang-v1_1",
    out: ["tts", "kokoro-multi-lang-v1_1"],
    probe: "model.onnx",
  },
];

export function fetchLeg(leg, opts = {}) {
  const dest = opts.dest ?? join(REPO, "packages", "voiced", "models");
  const spawn = opts.spawn ?? execFileSync;
  const outDir = join(dest, ...leg.out);
  const probe = join(outDir, leg.probe);
  if (existsSync(probe)) {
    console.log(`= ${leg.name}: already present (${outDir})`);
    return true;
  }
  const tmp = mkdtempSync(join(tmpdir(), "voiced-m-"));
  const urls = [leg.url, leg.url.replace("https://github.com", "https://hf-mirror.com")];
  let ok = false;
  for (const u of urls) {
    if (ok) break;
    console.log(`▶ ${leg.name}: ${u}`);
    // curl ships with Windows 10+ and every distro; -f fails on 404
    try {
      spawn("curl", ["-fL", "--retry", "3", "--connect-timeout", "20", "-o", "m.tar.bz2", u], { stdio: "inherit", cwd: tmp });
      ok = true;
    } catch {
      console.log(`  ✗ ${u} failed, trying fallback…`);
    }
  }
  if (!ok) {
    console.error(`✗ ${leg.name}: all sources failed (voiced /health will report this leg down)`);
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  // extraction goes to cwd — no -C, no absolute path, no host:path parsing
  try {
    spawn("tar", ["-xjf", "m.tar.bz2"], { stdio: "inherit", cwd: tmp });
    mkdirSync(outDir, { recursive: true });
    rmSync(outDir, { recursive: true, force: true });
    // rename() across devices throws — copy then clean, portable
    spawn(process.platform === "win32" ? "xcopy" : "cp", process.platform === "win32"
      ? [join(tmp, leg.inner), outDir, "\\E", "\\I", "\\Q", "\\Y"]
      : ["-r", join(tmp, leg.inner), outDir], { stdio: "inherit" });
  } catch (e) {
    // one bad leg must not kill the run: the other model still installs and
    // the exit code reports the missing leg for a rerun
    console.error(`✗ ${leg.name}: extract/move failed (${e && e.status ? `exit ${e.status}` : String(e && e.message || e).slice(0, 160)}) — rerun to retry`);
    rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${leg.name} → ${outDir}`);
  return existsSync(probe);
}

function main() {
  const dest = resolve(process.argv[2] ?? join(REPO, "packages", "voiced", "models"));
  mkdirSync(dest, { recursive: true });
  const results = LEGS.map((l) => fetchLeg(l, { dest }));
  console.log(results.every(Boolean) ? "done: all legs ready" : "done: some legs missing — rerun to retry");
  process.exitCode = results.every(Boolean) ? 0 : 1;
}

// run only when executed directly (electron-as-node spawns this file by path)
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
})();
if (invokedAsScript) main();
