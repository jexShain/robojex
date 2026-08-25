#!/bin/bash
# download-voice-models.sh — fetch the two ONNX model trees voiced serves.
# Idempotent: skips a leg whose target dir already has its model file.
# Primary: github releases (WSL proxy ok); fallback: hf-mirror.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/packages/voiced/models"
mkdir -p "$DEST/asr" "$DEST/tts"

fetch () { # url tarball outdir innerdir
  local url="$1" out="$2" inner="$3"
  local tmp="$(mktemp -d)"
  echo "▶ $(basename "$url")"
  if curl -fL --retry 3 --connect-timeout 20 -o "$tmp/m.tar.bz2" "$url" 2>/dev/null \
     || curl -fL --retry 3 --connect-timeout 20 -o "$tmp/m.tar.bz2" "${url/https:\/\/github.com/https:\/\/hf-mirror.com}" 2>/dev/null; then
    tar -xjf "$tmp/m.tar.bz2" -C "$tmp"
    mkdir -p "$out" && rm -rf "$out" && mv "$tmp/$inner" "$out"
    echo "✓ → $out"
  else
    echo "✗ download failed: $url" >&2
    rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
}

GH="https://github.com/k2-fsa/sherpa-onnx/releases/download"

[ -f "$DEST/asr/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx" ] \
  || fetch "$GH/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2" \
           "$DEST/asr/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" \
           "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" \
  || echo "  (asr leg unavailable — voiced /asr will report down)"

[ -f "$DEST/tts/kokoro-multi-lang-v1_1/model.onnx" ] \
  || fetch "$GH/tts-models/kokoro-multi-lang-v1_1.tar.bz2" \
           "$DEST/tts/kokoro-multi-lang-v1_1" \
           "kokoro-multi-lang-v1_1" \
  || echo "  (tts leg unavailable — voiced /tts will report down)"

echo "done. sizes:"; du -sh "$DEST"/*/* 2>/dev/null || true
