import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const cwd = fileURLToPath(new URL('.', import.meta.url))
const testGlobs = ['src/**/*.test.{ts,tsx}', 'packaging/**/*.test.js']
const nodeDocblock = /^\/\/ @vitest-environment node\r?$/

// Node suites opt out of jsdom so they never load DOM-only shims (issue #311).
export const nodeSuites: string[] = testGlobs
  .flatMap((pattern) => globSync(pattern, { cwd }))
  .filter((file) =>
    nodeDocblock.test(readFileSync(join(cwd, file), 'utf8').split('\n', 1)[0] ?? ''),
  )
  .sort()

export default defineConfig({
  test: {
    globals: true,
    // Component tests drive real timers and async IPC mocks; under a fully
    // parallel `pnpm verify` the default 5s is not enough on a loaded machine.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: testGlobs,
          exclude: [...configDefaults.exclude, ...nodeSuites],
          setupFiles: ['./src/test-setup.dom.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: nodeSuites,
        },
      },
    ],
  },
})
