// packages/web/vite.config.ts — Vite 6 config for the jex web console.
// Dev server proxies /api (HTTP + WS) to the core API on :7620 so the SPA can
// run against a local core without CORS. Production builds are static files
// served by core itself.
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // e2e can run beside a live backend owning 7620 (MOCK_PORT re-routes)
        target: `http://127.0.0.1:${process.env.MOCK_PORT || 7620}`,
        changeOrigin: true,
        ws: true,
      },
      // e2e test hooks on the mock (/mock/slow, /mock/ws-drop, …) — without
      // this they silently 404 into vite's SPA fallback and never land
      '/mock': {
        target: `http://127.0.0.1:${process.env.MOCK_PORT || 7620}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
