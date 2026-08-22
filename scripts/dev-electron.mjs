#!/usr/bin/env node
// scripts/dev-electron.mjs — dev orchestrator: vite dev server (:5173) +
// electron against it, no new dependencies (plain node child_process).
//
//   npm run electron:dev
//
// Exit codes propagate from electron; vite is torn down either way.
// Set ROBOJEX_EXTERNAL=1 before running to keep ceo-core out of the electron
// process (e.g. when jexd runs standalone in another terminal).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE_PORT = 5173;
const VITE_TIMEOUT_MS = 30_000;

const children = [];
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm needs a shell there
    ...opts,
  });
  children.push(child);
  return child;
}

async function waitForVite() {
  const deadline = Date.now() + VITE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${VITE_PORT}/`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const vite = run('npm', ['run', 'dev', '--workspace', '@robojex/web']);
const viteDown = new Promise((resolve) => vite.on('exit', () => resolve(false)));

const ready = await Promise.race([waitForVite(), viteDown]);
if (!ready) {
  console.error('[dev-electron] vite dev server 未在 30s 内就绪，退出');
  shutdown(1);
}

// electron resolves from the root workspace install
const electron = run('npx', ['electron', 'packages/electron/main.js']);
const code = await new Promise((resolve) => electron.on('exit', resolve));

console.log(`[dev-electron] electron 退出（code ${code}），正在关闭 vite…`);
shutdown(code);
