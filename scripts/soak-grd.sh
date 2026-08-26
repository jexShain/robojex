#!/bin/bash
# soak-grd.sh — the overnight soak daemon, managed from the repo (NOT /tmp:
# an external reaper wiped /tmp/robojex-grd mid-soak on 2026-08-24, board
# and MEMORY included). Runtime lives in .soak/ (gitignored).
# Usage: bash scripts/soak-grd.sh start|stop|status
# The pid file makes stop kill EXACTLY this daemon — a bare `pkill -f
# 'node dist/index.js'` also matched the user's live 7620 instance started
# the same way, taking the real butler down with the soak.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RT="$REPO/.soak"
LOG=$RT/server.log
PIDFILE=$RT/pid
API=http://127.0.0.1:7630/api/state

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

case "${1:-status}" in
  start)
    if alive; then echo "soak already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    mkdir -p "$RT"
    cd "$REPO/packages/ceo-core" || exit 1
    setsid nohup env ROBOJEX_RUNTIME="$RT" node dist/index.js >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    sleep 3
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API")
    echo "api=$code"
    echo "pid=$(cat "$PIDFILE")"
    ;;
  stop)
    if alive; then
      kill "$(cat "$PIDFILE")"
      sleep 1
      alive || echo "soak (pid $(cat "$PIDFILE")) stopped"
    else
      echo "no soak process left"
    fi
    rm -f "$PIDFILE"
    # pidfile-orphaned daemons (started before this script existed, or by a
    # racing second session) survive the kill above holding the port — the
    # next start then EADDRINUSEs into a dual-daemon interleaved ledger
    # (live-soak incident 2026-08-27: two loops wrote one sqlite for hours).
    # Hunt the port owner and take it down too.
    owner=$(ss -tlnp 2>/dev/null | awk '/:7630 /{for(i=1;i<=NF;i++) if($i ~ /pid=/) {sub("pid=","",$i); sub(",.*","",$i); print $i}}' | head -1)
    if [ -n "$owner" ]; then
      echo "port 7630 still held by orphan pid $owner — killing"
      kill "$owner" 2>/dev/null; sleep 1
      kill -9 "$owner" 2>/dev/null || true
    fi
    ;;
  status)
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API")
    echo "api=$code"
    if alive; then echo "pid=$(cat "$PIDFILE") alive"; else echo "daemon down"; fi
    ;;
esac
