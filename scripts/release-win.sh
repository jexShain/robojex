#!/usr/bin/env bash
# scripts/release-win.sh — one-shot Windows release pipeline (run from Git Bash
# ON WINDOWS). Syncs WSL source into C:\Users\xin\ai\robojex-win (version rides
# in packages/electron/package.json now — no post-sync bump), builds
# nsis+portable with npmmirror env, copies artifacts to the Desktop.
# Usage: bash scripts/release-win.sh <codename> [version]
#   e.g. bash scripts/release-win.sh 言出必行版 0.2.1
set -euo pipefail

SRC="${ROBOJEX_SRC:-//wsl.localhost/Ubuntu/home/xin/ai/robojex}"
WIN="${ROBOJEX_WIN:-C:/Users/xin/ai/robojex-win}"
DESKTOP="${ROBOJEX_DESKTOP:-C:/Users/xin/Desktop}"
CODENAME="${1:?usage: release-win.sh <codename> [version]}"

cd "$SRC"
VER="$(node -p "require('./packages/electron/package.json').version")"
echo "▶ source version: $VER (codename $CODENAME)"

echo "▶ tar sync $SRC -> $WIN"
tar cf - \
  --exclude='./node_modules' --exclude='node_modules' --exclude='.git' \
  --exclude='runtime' --exclude='probe-shots' --exclude='test-results' \
  --exclude='e2e-screenshots' --exclude='playwright-report' \
  --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='.git-msg-*.txt' \
  --exclude='dist' --exclude='dist-electron' --exclude='.last-run.json' \
  . | (cd "$WIN" && tar xf -)

cd "$WIN"
echo "▶ electron:build (npmmirror env; log: build-$VER.log)"
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run electron:build > "build-$VER.log" 2>&1 || { tail -20 "build-$VER.log"; exit 1; }

echo "▶ copy to Desktop"
cp "dist-electron/robojex $VER.exe" "$DESKTOP/robojex-$CODENAME.exe"
cp "dist-electron/robojex $VER.exe" "$DESKTOP/robojex.exe"
cp "dist-electron/robojex Setup $VER.exe" "$DESKTOP/robojex-$CODENAME-Setup.exe"
echo "✓ robojex $VER ($CODENAME) → Desktop (portable + setup + alias)"
