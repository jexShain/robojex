// packages/voiced/src/wav.mjs — RIFF/WAVE helpers shared by the daemon and
// the vitest protocol tests (kept importable WITHOUT starting the server).

/** Parse a RIFF/WAVE body: returns {sampleRate, samples: Float32Array}.
 *  Accepts 16-bit PCM mono/stereo-tolerant (data read as-is); anything else
 *  (bad magic, non-16-bit, truncated) → null. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let sampleRate = 0;
  let bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      if (bits !== 16) return null;
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return { sampleRate, samples };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Wrap mono Float32 samples into a 16-bit PCM WAV buffer. */
export function pcmWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}
