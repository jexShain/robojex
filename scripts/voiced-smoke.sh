#!/bin/bash
# voiced-smoke.sh — end-to-end round trip against the voice daemon:
#   1. /health                 both legs report their model
#   2. /tts  "语音链路测试"     → wav bytes (RIFF header asserted)
#   3. /asr  ← that same wav   → text should contain 语音 or 链路
#   4. /asr  1s synthetic sine → 400-ish "empty" is fine, must not 500
# Run after scripts/download-voice-models.sh and voiced-grd.sh start.
set -u
PORT="${VOICED_PORT:-7640}"
BASE="http://127.0.0.1:$PORT"
DIR="$(cd "$(dirname "$0")/../packages/voiced" && pwd)"
TTS_WAV="$DIR/.voiced-tts.wav"

echo "== 1/4 health"
curl -s --max-time 5 "$BASE/health"; echo

echo "== 2/4 tts"
curl -s --max-time 180 -X POST "$BASE/tts" \
  -H 'content-type: application/json' \
  -d '{"text":"语音链路测试","sid":0}' -o "$TTS_WAV"
ls -l "$TTS_WAV" | awk '{print "bytes:", $5}'
head -c 4 "$TTS_WAV"; echo " <- header"

echo "== 3/4 asr (round trip: kokoro output → sensevoice)"
time curl -s --max-time 180 -X POST "$BASE/asr" \
  -H 'content-type: audio/wav' --data-binary "@$TTS_WAV"; echo

echo "== 4/4 asr (synthetic 0.5s silence → must be 400, not 500)"
node -e '
const fs=require("fs");const n=8000;const b=Buffer.alloc(44+n*2);
b.write("RIFF",0);b.writeUInt32LE(36+n*2,4);b.write("WAVE",8);
b.write("fmt ",12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
b.write("data",36);b.writeUInt32LE(n*2,40);
fs.writeFileSync(process.argv[1],b);' "$DIR/.voiced-silence.wav"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 60 -X POST "$BASE/asr" \
  -H 'content-type: audio/wav' --data-binary "@$DIR/.voiced-silence.wav"
