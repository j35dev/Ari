import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Bundle workspace sources (@ari/*) into out/main — Node's runtime
        // loader cannot execute the raw TS sources, and the packaged asar
        // only ships out/**. Only true runtime externals stay external.
        external: [/^node:/, 'electron', '@lydell/node-pty'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          // Sandboxed renderers require a CommonJS preload script.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
})
