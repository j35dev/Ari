// Lightweight orchestrator: every check separately takes run-heavy.mjs gates.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [pnpmCli, outputDir = 'D:/Projects/.ari-cache/machines-integrated'] = process.argv.slice(2)
if (!pnpmCli) throw new Error('Expected absolute pnpm CLI path and optional log directory')
await mkdir(outputDir, { recursive: true })
const checks = [
  ['typecheck', ['-r', '--workspace-concurrency=1', 'typecheck']],
  ['lint', ['lint']],
  ...[
    'contracts',
    'remote-gateway',
    'remote-client',
    'engine',
    'ari-core',
    'providers',
    'shared',
    'ui',
    'mobile',
    'desktop',
  ].map((name) => [
    `${name}-tests`,
    ['--filter', `@ari/${name}`, 'test', '--maxWorkers=1', '--no-file-parallelism'],
  ]),
  ['desktop-build', ['--filter', '@ari/desktop', 'build']],
  ['mobile-build', ['--filter', '@ari/mobile', 'build']],
]
const results = []
for (const [name, args] of checks) {
  const logPath = join(outputDir, `${name}.log`)
  const log = createWriteStream(logPath)
  const startedAt = new Date().toISOString()
  const command = [
    process.execPath,
    join(import.meta.dirname, 'run-heavy.mjs'),
    `integrated-${name}`,
    process.cwd(),
    '--',
    process.execPath,
    pnpmCli,
    ...args,
  ]
  process.stdout.write(
    `${JSON.stringify({ check: name, status: 'started', startedAt, logPath })}\n`,
  )
  const result = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.once('error', (error) => resolve({ exitCode: null, error: error.message }))
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  await new Promise((resolve) => log.end(resolve))
  const entry = {
    name,
    command,
    cwd: process.cwd(),
    startedAt,
    finishedAt: new Date().toISOString(),
    logPath,
    ...result,
  }
  results.push(entry)
  await writeFile(join(outputDir, 'results.json'), JSON.stringify(results, null, 2))
  process.stdout.write(
    `${JSON.stringify({ check: name, status: 'finished', ...result, logPath })}\n`,
  )
}
process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0
