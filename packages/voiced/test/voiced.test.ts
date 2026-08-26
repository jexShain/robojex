// packages/voiced/test/voiced.test.ts — protocol-shape tests for the voice
// daemon's WAV contract (SPEC-VOICE). The HTTP surface itself is exercised
// by scripts/voiced-smoke.sh against real models; here we pin the byte
// format both sides agree on: recorder writes 16-bit PCM mono WAV, daemon
// parses any well-formed RIFF and re-wraps TTS samples the same way.

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWav, pcmWav } from "../src/wav.mjs";
import { parseModelsDir } from "../src/config.mjs";
import { createVoiceHandler } from "../src/index.mjs";

describe("pcmWav", () => {
  it("writes a canonical 44-byte header", () => {
    const buf = pcmWav(new Float32Array(100), 16000);
    expect(buf.length).toBe(244);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.readUInt32LE(4)).toBe(236); // 36 + 100 samples * 2 bytes
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt32LE(28)).toBe(32000); // byte rate
    expect(buf.readUInt16LE(34)).toBe(16); // bits
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt32LE(40)).toBe(200);
  });

  it("clamps out-of-range floats instead of wrapping int16", () => {
    const buf = pcmWav(new Float32Array([2, -2, 0.5]), 16000);
    expect(buf.readInt16LE(44)).toBe(32767);
    expect(buf.readInt16LE(46)).toBe(-32767);
    expect(buf.readInt16LE(48)).toBe(Math.round(0.5 * 32767));
  });
});

describe("parseWav", () => {
  it("round-trips pcmWav output", () => {
    const src = new Float32Array([0, 0.25, -0.25, 1, -1]);
    const wav = parseWav(pcmWav(src, 24000));
    expect(wav).not.toBeNull();
    expect(wav!.sampleRate).toBe(24000);
    expect(wav!.samples.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(wav!.samples[i] - src[i])).toBeLessThan(1 / 32760);
    }
  });

  it("skips unknown chunks before data (LIST/INFO tags)", () => {
    const base = pcmWav(new Float32Array([0.5]), 16000);
    // splice a 10-byte LIST chunk between the header and the tail
    const list = Buffer.alloc(18);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    list.write("INFOxxxxx", 8, "ascii");
    const patched = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    // RIFF size must grow by the splice or some parsers stop early — ours
    // walks chunks, so accept either shape but require the data to survive
    const wav = parseWav(patched);
    expect(wav).not.toBeNull();
    expect(Math.abs(wav!.samples[0] - 0.5)).toBeLessThan(1 / 32760);
  });

  it("rejects non-RIFF, truncated, and non-16-bit bodies", () => {
    expect(parseWav(Buffer.from("not a wav at all, really not one!"))).toBeNull();
    expect(parseWav(Buffer.alloc(10))).toBeNull();
    const bits32 = pcmWav(new Float32Array(4), 16000);
    bits32.writeUInt16LE(32, 34); // lie about the sample width
    expect(parseWav(bits32)).toBeNull();
  });
});

describe("voice daemon HTTP surface (createVoiceHandler)", () => {
  it("/tts 200 WAV carries the CORS headers the renderer needs", async () => {
    // regression: the success body used to be the ONLY response without
    // access-control-allow-origin — the cross-origin renderer fetch (dev
    // vite :5173, prod core :7620) could not read it, silently killing
    // every voice report against the real daemon
    const { server, url, sherpa } = await startFake();
    try {
      const r = await fetch(`${url}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "一切正常", sid: 0 }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(sherpa.ttsCalls).toBe(1);
      const body = Buffer.from(await r.arrayBuffer());
      expect(body.toString("ascii", 0, 4)).toBe("RIFF");
    } finally {
      server.close();
    }
  });

  it("a failed engine load retries on the next request (no permanent wedge)", async () => {
    // regression: a throwing construct left a rejected promise in loading.tts
    // forever — every later /tts rethrew the stale error (500) and /health
    // stayed "loading"; only a daemon restart recovered
    const { server, url, sherpa } = await startFake();
    try {
      sherpa.failNextTts = new Error("corrupt model");
      const r1 = await fetch(`${url}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(r1.status).toBe(500);

      const r2 = await fetch(`${url}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(r2.status).toBe(200); // the retry actually re-constructed the engine
      expect(sherpa.ttsCalls).toBe(1);
    } finally {
      server.close();
    }
  });
});

/** Fake sherpa + tmp models dir + listening server on an ephemeral port. */
async function startFake() {
  const dir = mkdtempSync(join(tmpdir(), "voiced-http-"));
  mkdirSync(join(dir, "asr", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"), { recursive: true });
  const ttsDir = join(dir, "tts", "kokoro-multi-lang-v1_1");
  mkdirSync(ttsDir, { recursive: true });
  writeFileSync(join(ttsDir, "model.onnx"), "fake"); // existsSync gate only
  const sherpa = {
    ttsCalls: 0,
    failNextTts: null as Error | null,
    OfflineTts: class {
      constructor() {
        const err = sherpa.failNextTts;
        sherpa.failNextTts = null;
        if (err) throw err;
        sherpa.ttsCalls++;
      }
      generate() { return { samples: new Float32Array([0.1, -0.1, 0.5]), sampleRate: 24000 }; }
    },
    OfflineRecognizer: class {
      createStream() { return { acceptWaveform() {}, free() {} }; }
      decode() {}
      getResult() { return { text: "ok" }; }
    },
  };
  const server = createServer(createVoiceHandler({ sherpaModule: sherpa, modelsDir: dir }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${addr.port}`, sherpa, dir };
}

describe("parseModelsDir", () => {
  it("--models wins over env over default", () => {
    expect(parseModelsDir(["node", "index.mjs", "--models", "/x/y"], {}, "/dflt")).toBe("/x/y");
    expect(parseModelsDir(["node", "index.mjs"], { VOICED_MODELS_DIR: "/env/dir" }, "/dflt")).toBe("/env/dir");
    // --models beats a set env (the Electron shell always passes --models)
    expect(parseModelsDir(["--models", "/flag"], { VOICED_MODELS_DIR: "/env/dir" }, "/dflt")).toBe("/flag");
    expect(parseModelsDir(["node"], {}, "/dflt")).toBe("/dflt");
  });

  it("a --models flag without a value falls through to env", () => {
    expect(parseModelsDir(["--models"], { VOICED_MODELS_DIR: "/env/dir" }, "/dflt")).toBe("/env/dir");
  });
});
