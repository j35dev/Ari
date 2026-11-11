// Run only inside the swarm's shared run-heavy lease. No installs or wide suites.
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const pnpm = process.argv[2]
if (!pnpm) throw new Error('Pass the absolute pnpm CLI path.')
const files = execFileSync('git', ['diff', '--name-only', '6f018a75'], {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
})
  .trim()
  .split(/\r?\n/)
  .filter((path) => /\.(?:ts|tsx|mjs)$/.test(path))
const checks = [
  ['exec', 'eslint', ...files],
  ['exec', 'tsc', '--noEmit', '-p', 'docs/research/parallel-root-typecheck.json'],
  [
    '--filter',
    '@ari/desktop',
    'exec',
    'vitest',
    'run',
    'src/main/root-concurrency.test.ts',
    'src/renderer/src/App.first-session.test.tsx',
    '--maxWorkers=1',
    '--no-file-parallelism',
  ],
]
for (const args of checks) {
  process.stdout.write(`${JSON.stringify({ focusedCheck: args })}\n`)
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
