// One shared resource lease for Machines validation on this Windows host.
// Usage: node run-heavy.mjs WORKER WORKTREE -- node ABS_PNPM_CLI [args...]
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setPriority, constants } from 'node:os'
import { spawn } from 'node:child_process'

const [worker, cwd, separator, executable, ...args] = process.argv.slice(2)
if (!worker || !cwd || separator !== '--' || !executable) {
  throw new Error('Expected WORKER WORKTREE -- EXECUTABLE [ARGS...]')
}
const lockPath = 'D:/Projects/Ari-machines-wt/.heavy.lock'
const owner = { worker, pid: process.pid, startedAt: new Date().toISOString(), id: randomUUID() }
const staleMs = 30 * 60_000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let child = null
let heartbeat = null

async function readLock() {
  try { return await readFile(lockPath, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function acquire() {
  await mkdir(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      const file = await open(lockPath, 'wx')
      try { await file.writeFile(JSON.stringify(owner)) } finally { await file.close() }
      output({ heavyLock: 'acquired', ...owner })
      return
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    const observed = await readLock()
    if (observed === null) continue
    try {
      const info = await stat(lockPath)
      if (Date.now() - info.mtimeMs > staleMs && observed === await readLock()) {
        await unlink(lockPath)
        output({ heavyLock: 'removed-stale', previous: observed })
        continue
      }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    output({ heavyLock: 'waiting', owner: observed })
    await delay(30_000)
  }
}
async function release() {
  clearInterval(heartbeat)
  const current = await readLock()
  if (current !== null && JSON.parse(current).id === owner.id) await unlink(lockPath)
}
function run(exe, argv, capture = false) {
  return new Promise((resolve, reject) => {
    child = spawn(exe, argv, { cwd, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => { child = null; resolve({ code, signal, stdout, stderr }) })
  })
}
async function resourceGate() {
  const script = "$c=(Get-PSDrive C).Free; $samples=(Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit').CounterSamples; $used=($samples | Where-Object { $_.Path -like '*committed bytes' }).CookedValue; $limit=($samples | Where-Object { $_.Path -like '*commit limit' }).CookedValue; @{cFreeBytes=$c;commitHeadroomBytes=($limit-$used)} | ConvertTo-Json -Compress"
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], true)
  if (result.code !== 0) throw new Error(`Resource counters unavailable: ${result.stderr}`)
  const values = JSON.parse(result.stdout)
  if (!Number.isFinite(values.cFreeBytes) || !Number.isFinite(values.commitHeadroomBytes)) {
    throw new Error('Resource counters did not return finite values')
  }
  output({ resourceGate: values })
  return values.cFreeBytes >= 5 * 1024 ** 3 && values.commitHeadroomBytes >= 1.5 * 1024 ** 3
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { if (child !== null) child.kill(signal); process.exitCode = 130 })
}

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
process.env.TEMP = 'D:/Projects/.ari-cache/tmp'
process.env.TMP = process.env.TEMP
process.env.npm_config_cache = 'D:/Projects/.ari-cache/npm'
process.env.ELECTRON_CACHE = 'D:/Projects/.ari-cache/electron'
process.env.ELECTRON_BUILDER_CACHE = 'D:/Projects/.ari-cache/electron-builder'
try {
  await acquire()
  heartbeat = setInterval(() => {
    void readLock().then((value) => {
      if (value !== null && JSON.parse(value).id === owner.id) {
        return utimes(lockPath, new Date(), new Date())
      }
    }).catch((error) => output({ heartbeatError: error.message }))
  }, 60_000)
  const gateStarted = Date.now()
  while (!await resourceGate()) {
    if (Date.now() - gateStarted >= 15 * 60_000) throw new Error('Resource gate remained below its floor for 15 minutes')
    output({ resourceGate: 'waiting-two-minutes' })
    await delay(120_000)
  }
  const result = await run(executable, args)
  output({ heavyResult: { worker, executable, args, exitCode: result.code, signal: result.signal } })
  process.exitCode = result.code ?? 1
} finally {
  await release()
}
