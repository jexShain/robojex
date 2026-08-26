#!/usr/bin/env node
// packages/voiced/src/index.mjs — the local voice daemon (SPEC-VOICE).
// One sherpa-onnx runtime serves BOTH directions, fully offline:
//   POST /asr  body = WAV (16-bit PCM mono, any rate; resample-free path
//                    assumes 16k — the recorder window records exactly that)
//                    → {"text": "..."} (SenseVoice: zh/en/ja/ko + ITN + 标点)
//   POST /tts  {"text": "...", "sid"?: 0..4} → audio/wav (16k? model rate)
//   GET  /health → {"asr":"sensevoice","tts":"kokoro"} or "down" per leg
// Models lazy-load on first use and stay resident (SenseVoice ~1s cold,
// Kokoro ~2s); a missing models/ tree degrades that leg to "down" with a
// one-line how-to-fix in /health.
// The handler is a factory (createVoiceHandler) so tests can inject a fake
// sherpa module and tmp model dirs; the production entry only runs as main.

import http from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseWav, pcmWav } from "./wav.mjs";
import { parseModelsDir } from "./config.mjs";

export { parseWav, pcmWav, parseModelsDir };

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // packages/voiced
const MODELS = join(ROOT, "models");
const ASR_SUBDIR = join("asr", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17");
const TTS_SUBDIR = join("tts", "kokoro-multi-lang-v1_1");
// SenseVoice language pin: "" = auto (unreliable on short clips), "zh" biases
// the decoder to Chinese while still handling embedded English words
const ASR_LANG = process.env.VOICED_ASR_LANG ?? "zh";

/**
 * Build the HTTP handler with injectable engines and model root.
 * @param {{ sherpaModule: object, modelsDir: string, asrLang?: string }} deps
 */
export function createVoiceHandler({ sherpaModule, modelsDir, asrLang = ASR_LANG }) {
  const ASR_DIR = join(modelsDir, ASR_SUBDIR);
  const TTS_DIR = join(modelsDir, TTS_SUBDIR);

  // ---------- engines (lazy) ----------
  let recognizer = null;
  let tts = null;
  const loading = { asr: null, tts: null };

  function loadAsr() {
    if (recognizer) return recognizer;
    if (!existsSync(join(ASR_DIR, "model.int8.onnx"))) return null;
    if (!loading.asr) {
      const p = (async () => {
        recognizer = new sherpaModule.OfflineRecognizer({
          modelConfig: {
            senseVoice: { model: join(ASR_DIR, "model.int8.onnx"), language: asrLang, useInverseTextNormalization: 1 },
            tokens: join(ASR_DIR, "tokens.txt"),
            numThreads: 2,
            debug: 0,
            provider: "cpu",
          },
        });
        console.log("[voiced] sensevoice loaded");
      })();
      loading.asr = p;
      // a failed construct (corrupt model, native OOM) must not wedge the leg:
      // the marker is cleared on a LATER microtask (clearing inside the async
      // body would run before the `loading.asr = p` assignment itself), so
      // the next request retries instead of rethrowing a stale rejected
      // promise forever. The identity guard keeps a newer load in charge.
      p.catch(() => { if (loading.asr === p) loading.asr = null; });
    }
    return undefined; // still loading
  }

  function loadTts() {
    if (tts) return tts;
    if (!existsSync(join(TTS_DIR, "model.onnx"))) return null;
    if (!loading.tts) {
      const p = (async () => {
        tts = new sherpaModule.OfflineTts({
          model: {
            kokoro: {
              model: join(TTS_DIR, "model.onnx"),
              voices: join(TTS_DIR, "voices.bin"),
              tokens: join(TTS_DIR, "tokens.txt"),
              dataDir: join(TTS_DIR, "espeak-ng-data"),
              // v1.1 multi-lang frontend: per-language lexicons, comma-joined
              lexicon: [join(TTS_DIR, "lexicon-us-en.txt"), join(TTS_DIR, "lexicon-zh.txt")].join(","),
              dictDir: join(TTS_DIR, "dict"),
              lengthScale: 1.0,
            },
          },
          numThreads: 2,
          debug: 0,
          provider: "cpu",
        });
        console.log("[voiced] kokoro loaded");
      })();
      loading.tts = p;
      p.catch(() => { if (loading.tts === p) loading.tts = null; }); // same retry contract as the ASR leg
    }
    return undefined;
  }



  // ---------- http helpers ----------
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      // the web renderer fetches /tts directly for voice reports — same-origin
      // in prod (via its own origin), cross-origin in dev (vite :5173)
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end(body);
  }

  async function readBody(req, cap = 20 * 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > cap) throw new Error("body too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // ---------- handler ----------
  return async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    // CORS preflight for renderer-side /tts fetches (dev vite origin)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "86400",
      });
      return res.end();
    }
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        // per leg: "sensevoice"/"kokoro" = loaded, "loading" = lazy load in
        // flight, "idle" = models present but never used yet, "down" = missing
        const leg = (present, ready, loadingP, loaded) =>
          !present ? "down" : loaded ? ready : loadingP ? "loading" : "idle";
        const asr = leg(existsSync(join(ASR_DIR, "model.int8.onnx")), "sensevoice", loading.asr, !!recognizer);
        const ttsS = leg(existsSync(join(TTS_DIR, "model.onnx")), "kokoro", loading.tts, !!tts);
        return json(res, 200, { asr: asr, tts: ttsS, hint: asr === "down" || ttsS === "down" ? "models missing - desktop app: Settings download button; repo: node scripts/download-voice-models.mjs <dir>" : "" });
      }
      if (url.pathname === "/asr" && req.method === "POST") {
        loadAsr();
        if (loading.asr) await loading.asr;
        if (!recognizer) return json(res, 503, { error: "asr model missing — models missing - desktop app: Settings download button; repo: node scripts/download-voice-models.mjs <dir>" });
        const body = await readBody(req);
        const wav = parseWav(body);
        if (!wav) return json(res, 400, { error: "body must be a 16-bit PCM mono WAV" });
        if (wav.samples.length < 1600) return json(res, 400, { error: "audio too short (<0.1s)" });
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: wav.sampleRate, samples: wav.samples });
        recognizer.decode(stream);
        const text = recognizer.getResult(stream).text.trim();
        stream.free?.();
        return json(res, 200, { text });
      }
      if (url.pathname === "/tts" && req.method === "POST") {
        loadTts();
        if (loading.tts) await loading.tts;
        if (!tts) return json(res, 503, { error: "tts model missing — models missing - desktop app: Settings download button; repo: node scripts/download-voice-models.mjs <dir>" });
        const body = await readBody(req, 64 * 1024);
        let q;
        try { q = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "bad json" }); }
        const text = typeof q.text === "string" ? q.text.trim().slice(0, 2000) : "";
        if (!text) return json(res, 400, { error: "text must be a non-empty string" });
        const sid = Number.isInteger(q.sid) && q.sid >= 0 && q.sid <= 4 ? q.sid : 0; // 0..2 zh-female, 3..4 zh-male
        const out = tts.generate({ text, sid, speed: 1.0 });
        const wav = pcmWav(out.samples, out.sampleRate);
        // CORS on the SUCCESS body too: the renderer's cross-origin fetch
        // reads THIS response — the preflight passes but a headerless 200
        // is still unreadable, silently killing every voice report
        res.writeHead(200, {
          "content-type": "audio/wav",
          "content-length": wav.length,
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        });
        return res.end(wav);
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : "internal" });
    }
  };
}

// ---------- production entry (direct `node index.mjs`, pkg binary) ----------
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    // realpath both sides: the bin entry may run through a symlinked path
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node");
  const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : process.env.VOICED_PORT ?? 7640);
  // the packaged Windows sidecar keeps its 2GB model trees OUT of the app
  // dir — the Electron shell passes --models %APPDATA%/RoboJex/voiced-models
  const modelsDir = parseModelsDir(process.argv, process.env, MODELS);
  const server = http.createServer(createVoiceHandler({ sherpaModule: sherpa, modelsDir }));
  server.listen(port, "127.0.0.1", () => {
    console.log(`[voiced] http://127.0.0.1:${port} models=${modelsDir} (asr: sensevoice, tts: kokoro — lazy)`);
  });
}
