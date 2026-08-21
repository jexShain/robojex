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
        target: 'http://127.0.0.1:7620',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
