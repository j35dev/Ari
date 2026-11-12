import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Bundle workspace sources (@ari/*) into out/main — Node's runtime
        // loader cannot execute the raw TS sources, and the packaged asar
        // only ships out/**. Only true runtime externals stay external.
        external: [
          /^node:/,
          'electron',
          // Keep ws's guarded optional native peer loading at runtime. Vite's
          // development placeholder otherwise throws before Ari can start.
          'ws',
          '@lydell/node-pty',
          'electron-updater',
          'koffi',
          'transcribe-cpp',
          'uiohook-napi',
        ],
        input: {
          index: 'src/main/index.ts',
          'speech-worker': 'src/main/speech/worker.ts',
          'dictation-worker': 'src/main/speech/dictation-worker.ts',
          'audio-ducking-worker': 'src/main/speech/audio-ducking-worker.ts',
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          widget: resolve('src/main/aria-widget/preload.ts'),
        },
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
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          widget: resolve('src/renderer/widget/index.html'),
        },
      },
    },
  },
})
