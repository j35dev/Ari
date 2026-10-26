import { globSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const cwd = fileURLToPath(new URL('.', import.meta.url))
const testGlobs = ['src/**/*.test.{ts,tsx}', 'packaging/**/*.test.js']
const nodeDocblock = /^\s*(?:\/\/|\/\*+)?\s*@vitest-environment\s+node\b/

// The docblock is only a docblock at the top of the file, but both the `//` and
// the `/** … */` forms count. A suite that matches vitest's rule yet is left out
// here would load the DOM setup under `environment: node` and die with
// "Element is not defined" inside the setup file (issue #311).
export function hasNodeDocblock(source: string): boolean {
  return source
    .split(/\r?\n/)
    .slice(0, 3)
    .some((line) => nodeDocblock.test(line))
}

// `globSync` returns platform separators; vitest matches `include`/`exclude`
// patterns with forward slashes, so a backslash path would leave the DOM
// project's exclusion of these suites inert on Windows.
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

// Node suites opt out of jsdom so they never load DOM-only shims (issue #311).
export const nodeSuites: string[] = testGlobs
  .flatMap((pattern) => globSync(pattern, { cwd }))
  .map(toPosix)
  .filter((file) => hasNodeDocblock(readFileSync(join(cwd, file), 'utf8')))
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
