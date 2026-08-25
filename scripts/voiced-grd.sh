#!/bin/bash
# voiced-grd.sh — start|stop|status for the local voice daemon (:7640).
# Setsid-detached so it survives harness/terminal reaping; log beside source.
set -u
DIR="$(cd "$(dirname "$0")/../packages/voiced" && pwd)"
LOG="$DIR/.voiced.log"
PORT="${VOICED_PORT:-7640}"

case "${1:-status}" in
start)
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "voiced already up on :$PORT"; exit 0
  fi
  setsid nohup node "$DIR/src/index.mjs" >> "$LOG" 2>&1 &
  sleep 0.3
  echo "voiced started (log: $LOG)"
  ;;
stop)
  pkill -f 'packages/voiced/src/index[.]mjs' 2>/dev/null || true
  echo "voiced stopped"
  ;;
status)
  curl -s --max-time 2 "http://127.0.0.1:$PORT/health" || echo '{"down":true}'
  echo
  ;;
*)
  echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
