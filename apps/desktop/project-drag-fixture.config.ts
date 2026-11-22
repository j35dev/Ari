import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve('out/project-drag-renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/testing/project-drag.html') },
  },
})
