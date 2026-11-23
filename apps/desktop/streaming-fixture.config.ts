import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/** Offline review surface. No Electron main, gateway or production routing changes. */
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5317, strictPort: true },
  build: {
    outDir: resolve('out/streaming-fixture'),
    emptyOutDir: true,
    rollupOptions: {
      input: [
        resolve('src/renderer/testing/streaming.html'),
        resolve('src/renderer/testing/streaming-v2.html'),
        resolve('src/renderer/testing/streaming-fixed.html'),
        resolve('src/renderer/testing/subagents-fixed.html'),
      ],
    },
  },
})
