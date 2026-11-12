import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/** Deterministic renderer-only fixture; never boots Electron or a host gateway. */
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: resolve('out/machines-fixture'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/testing/machines.html') },
  },
})
