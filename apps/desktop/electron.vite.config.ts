import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mainCommonjsShimPlugin } from './packaging/main-commonjs-shim'

function buildCommit(): string | null {
  try {
    if (
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim()
    )
      return null
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim()
  } catch {
    return null
  }
}

export default defineConfig({
  main: {
    define: { __ARI_BUILD_COMMIT__: JSON.stringify(buildCommit()) },
    plugins: [mainCommonjsShimPlugin()],
    build: {
      rollupOptions: {
        // Bundle workspace sources (@ari/*) into out/main — Node's runtime
        // loader cannot execute the raw TS sources, and the packaged asar
        // only ships out/**. Only true runtime externals stay external.
        // Claude Agent SDK is pure JS and declared as a desktop devDependency
        // so it is bundled here. It always launches the user's detected CLI.
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
          'sherpa-onnx-node',
          'uiohook-napi',
        ],
        input: {
          index: 'src/main/index.ts',
          'voice-worker': 'src/main/speech/voice-worker.ts',
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
    server: process.env.ARI_DEV_RENDERER_PORT
      ? { port: Number(process.env.ARI_DEV_RENDERER_PORT), strictPort: true }
      : undefined,
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
