// packages/voiced/test/voiced.test.ts — protocol-shape tests for the voice
// daemon's WAV contract (SPEC-VOICE). The HTTP surface itself is exercised
// by scripts/voiced-smoke.sh against real models; here we pin the byte
// format both sides agree on: recorder writes 16-bit PCM mono WAV, daemon
// parses any well-formed RIFF and re-wraps TTS samples the same way.

import { describe, expect, it } from "vitest";
import { parseWav, pcmWav } from "../src/wav.mjs";

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
