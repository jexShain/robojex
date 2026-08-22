import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The mock and the vite /api proxy both follow this, so the suite can run
// beside a live ceo-core (or the packaged desktop app) owning 7620.
const MOCK_PORT = Number(process.env.MOCK_PORT || 7620)

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 860 },
    trace: 'off',
  },
  webServer: [
    {
      command: 'node e2e/mock-backend.mjs',
      cwd: repoRoot,
      port: MOCK_PORT,
      reuseExistingServer: !process.env.MOCK_PORT, // an explicit port must not silently reuse whatever owns 7620
      timeout: 15_000,
    },
    {
      command: 'npx vite --port 5199 --strictPort',
      cwd: path.join(repoRoot, 'packages/web'),
      port: 5199,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
})
