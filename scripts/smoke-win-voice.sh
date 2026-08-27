#!/usr/bin/env bash
# scripts/smoke-win-voice.sh — packaged voice-stack smoke (run from Git Bash
# ON WINDOWS, after release-win.sh). Spawns the packaged sidecar the same way
# main.js does (exe as node, extraResources entry) and round-trips TTS→ASR.
# This is the guard for the 0.2.18 first-run bug class: the extraResources
# layout, the model downloader's output, and Electron's V8 external-buffer
# cage are all invisible to vitest/e2e and only bite in the packaged exe.
#
# Usage: bash scripts/smoke-win-voice.sh [winUnpackedDir] [modelsDir]
#   winUnpackedDir default: C:/Users/xin/ai/robojex-win/dist-electron/win-unpacked
#   modelsDir      default: $APPDATA/robojex/voice-models
# Exit: 0 pass · 1 fail · 3 SKIP (no models downloaded yet — nothing to test)
set -u
WIN="${1:-C:/Users/xin/ai/robojex-win/dist-electron/win-unpacked}"
MODELS="${2:-$(cygpath -u "$APPDATA")/robojex/voice-models}"
PORT=7691
BASE="http://127.0.0.1:$PORT"

[ -f "$WIN/robojex.exe" ] || { echo "✗ no packaged exe at $WIN/robojex.exe"; exit 1; }
if [ ! -f "$MODELS/tts/kokoro-multi-lang-v1_1/model.onnx" ] || [ ! -f "$MODELS/asr/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx" ]; then
  echo "SKIP: no voice models under $MODELS (run the app's download once to enable this smoke)"
  exit 3
fi

# Chinese rides as JSON \\uXXXX escapes — pure-ASCII argv can never mojibake
# (a Git-Bash curl -d with raw 中文 bytes produces phoneme soup that looks
# exactly like an engine bug; ask the 08-27 debugging session)
REQ=$(mktemp); WAV=$(mktemp)
printf '{"text":"\\u8bed\\u97f3\\u94fe\\u8def\\u6d4b\\u8bd5","sid":0}' > "$REQ"

taskkill //F //IM robojex.exe >/dev/null 2>&1 || true   # a locked old instance fails EADDRINUSE
cd "$WIN" || exit 1
ELECTRON_RUN_AS_NODE=1 ./robojex.exe resources/voiced/src/index.mjs --port "$PORT" --models "$(cygpath -w "$MODELS")" >/tmp/voiced-smoke.log 2>&1 &
SC=$!

cleanup() { kill "$SC" >/dev/null 2>&1; rm -f "$REQ" "$WAV"; }
trap cleanup EXIT

for i in $(seq 1 20); do curl -s -m 2 "$BASE/health" | grep -q '"asr"' && break; sleep 1; done
H=$(curl -s -m 5 "$BASE/health" || true)
echo "health: $H"
echo "$H" | grep -q '"asr":"sensevoice"\|"asr":"idle"' || { echo "✗ sidecar never came up (see /tmp/voiced-smoke.log)"; exit 1; }

echo "▶ tts (kokoro under Electron's V8 cage)"
code=$(curl -s -m 180 -X POST "$BASE/tts" -H 'content-type: application/json' --data-binary @"$REQ" -o "$WAV" -w '%{http_code}')
size=$(wc -c < "$WAV" 2>/dev/null || echo 0)
echo "  http=$code bytes=$size"
[ "$code" = "200" ] || { echo "✗ tts failed (external-buffer/lexicon regression?)"; tail -5 /tmp/voiced-smoke.log; exit 1; }
head -c 4 "$WAV" | grep -q RIFF || { echo "✗ tts body is not a RIFF wav"; exit 1; }
# known-good synthesis of this sentence is ~72KB; phoneme-soup blowups run 5x long
[ "$size" -gt 30000 ] && [ "$size" -lt 200000 ] || { echo "✗ tts wav size $size outside the healthy 30k-200k band (frontend garbling?)"; exit 1; }

echo "▶ asr (sensevoice decodes its own tts)"
code=$(curl -s -m 180 -X POST "$BASE/asr" -H 'content-type: audio/wav' --data-binary @"$WAV" -w '%{http_code}' -o /tmp/voiced-smoke-asr.json)
echo "  http=$code $(cat /tmp/voiced-smoke-asr.json)"
[ "$code" = "200" ] || { echo "✗ asr failed"; exit 1; }
# empty decode is exactly {"text":"."} or {"text":""} — a bare dot/empty
# between the quotes; any real decode has more than that
grep -aqE '"text": *"\.?"' /tmp/voiced-smoke-asr.json && { echo "✗ asr decoded empty — audio or decoder broken"; exit 1; }
grep -aq '"text"' /tmp/voiced-smoke-asr.json || { echo "✗ asr returned no text field"; exit 1; }

echo "✓ packaged voice stack round-trips"
exit 0
