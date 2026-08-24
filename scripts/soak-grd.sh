#!/bin/bash
# soak-grd.sh — the overnight soak daemon, managed from the repo (NOT /tmp:
# an external reaper wiped /tmp/robojex-grd mid-soak on 2026-08-24, board
# and MEMORY included). Runtime lives in .soak/ (gitignored).
# Usage: bash scripts/soak-grd.sh start|stop|status
set -u
RT=/home/xin/ai/robojex/.soak
LOG=$RT/server.log
case "${1:-status}" in
  start)
    mkdir -p "$RT"
    cd /home/xin/ai/robojex/packages/ceo-core || exit 1
    setsid nohup env ROBOJEX_RUNTIME="$RT" node dist/index.js >> "$LOG" 2>&1 < /dev/null &
    sleep 3
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7630/api/state)
    echo "api=$code"
    pgrep -af 'node dist/index' | head -2
    ;;
  stop)
    pkill -f 'node dist/index[.]js'
    sleep 1
    pgrep -af 'node dist/index[.]js' || echo "no soak process left"
    ;;
  status)
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7630/api/state)
    echo "api=$code"
    pgrep -af 'node dist/index[.]js' | grep -v grep | head -2
    ;;
esac
