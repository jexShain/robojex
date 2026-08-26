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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = resolve(process.argv[2] ?? join(REPO, "packages", "voiced", "models"));
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

const LEGS = [
  {
    name: "sensevoice-asr",
    url: `${GH}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2`,
    inner: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    out: ["asr", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"],
    probe: "model.int8.onnx",
  },
  {
    name: "kokoro-tts",
    url: `${GH}/tts-models/kokoro-multi-lang-v1_1.tar.bz2`,
    inner: "kokoro-multi-lang-v1_1",
    out: ["tts", "kokoro-multi-lang-v1_1"],
    probe: "model.onnx",
  },
];

function fetchLeg(leg) {
  const outDir = join(DEST, ...leg.out);
  const probe = join(outDir, leg.probe);
  if (existsSync(probe)) {
    console.log(`= ${leg.name}: already present (${outDir})`);
    return true;
  }
  const tmp = mkdtempSync(join(tmpdir(), "voiced-m-"));
  const tarball = join(tmp, "m.tar.bz2");
  const urls = [leg.url, leg.url.replace("https://github.com", "https://hf-mirror.com")];
  let ok = false;
  for (const u of urls) {
    if (ok) break;
    console.log(`▶ ${leg.name}: ${u}`);
    // curl ships with Windows 10+ and every distro; -f fails on 404
    try {
      execFileSync("curl", ["-fL", "--retry", "3", "--connect-timeout", "20", "-o", tarball, u], { stdio: "inherit" });
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
  execFileSync("tar", ["-xjf", tarball, "-C", tmp], { stdio: "inherit" }); // Win10+ bsdtar reads bz2
  mkdirSync(outDir, { recursive: true });
  rmSync(outDir, { recursive: true, force: true });
  // rename() across devices throws — copy then clean, portable
  execFileSync(process.platform === "win32" ? "xcopy" : "cp", process.platform === "win32"
    ? [join(tmp, leg.inner), outDir, "\\E", "\\I", "\\Q", "\\Y"]
    : ["-r", join(tmp, leg.inner), outDir], { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${leg.name} → ${outDir}`);
  return existsSync(probe);
}

mkdirSync(DEST, { recursive: true });
const results = LEGS.map(fetchLeg);
console.log(results.every(Boolean) ? "done: all legs ready" : "done: some legs missing — rerun to retry");
process.exitCode = results.every(Boolean) ? 0 : 1;
