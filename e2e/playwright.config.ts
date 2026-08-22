import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
      port: 7620,
      reuseExistingServer: true,
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
