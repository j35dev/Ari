// Up to two resource leases for Machines validation on this Windows host.
// Usage: node run-heavy.mjs WORKER WORKTREE -- node ABS_PNPM_CLI [args...]
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { setPriority, constants } from 'node:os'
import { spawn } from 'node:child_process'
import { clearInterval, setInterval, setTimeout } from 'node:timers'

const [worker, cwd, separator, executable, ...args] = process.argv.slice(2)
if (!worker || !cwd || separator !== '--' || !executable) {
  throw new Error('Expected WORKER WORKTREE -- EXECUTABLE [ARGS...]')
}
const lockPaths = [
  'D:/Projects/Ari-machines-wt/.heavy.lock',
  'D:/Projects/Ari-machines-wt/.heavy.2.lock',
]
const admissionPath = 'D:/Projects/Ari-machines-wt/.heavy.admission.lock'
let lockPath = null
const owner = { worker, pid: process.pid, startedAt: new Date().toISOString(), id: randomUUID() }
const staleMs = 30 * 60_000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let child = null
let heartbeat = null
let cancelled = false

async function readLock(path = lockPath) {
  if (path === null) return null
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function acquire() {
  await mkdir(dirname(admissionPath), { recursive: true })
  let failedSince = null
  for (;;) {
    if (cancelled) throw new Error('Heavy step cancelled while waiting for its lease')
    let admission = null
    try {
      admission = await open(admissionPath, 'wx')
      await admission.writeFile(JSON.stringify(owner))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (admission !== null) {
      try {
        for (const path of lockPaths) await reclaim(path)
        const values = await resourceGate()
        const healthy =
          values.cFreeBytes >= 5 * 1024 ** 3 && values.commitHeadroomBytes >= 1.5 * 1024 ** 3
        failedSince = healthy ? null : (failedSince ?? Date.now())
        const capacity = values.commitHeadroomBytes >= 6 * 1024 ** 3 ? 2 : 1
        const occupied = await Promise.all(lockPaths.map((path) => readLock(path)))
        if (healthy && occupied.filter((value) => value !== null).length < capacity) {
          lockPath = lockPaths[occupied.findIndex((value) => value === null)]
          const file = await open(lockPath, 'wx')
          try {
            await file.writeFile(JSON.stringify(owner))
          } finally {
            await file.close()
          }
          output({ heavyLock: 'acquired', slot: lockPath, capacity, ...owner })
          return
        }
        if (!healthy && Date.now() - failedSince >= 15 * 60_000)
          throw new Error('Resource gate remained below its floor for 15 minutes')
        if (healthy) output({ heavyLock: 'waiting', capacity, owners: occupied })
        else output({ resourceGate: 'waiting-thirty-seconds' })
      } finally {
        await admission.close()
        if ((await readLock(admissionPath)) === JSON.stringify(owner)) await unlink(admissionPath)
      }
    } else await reclaim(admissionPath)
    await delay(30_000)
  }
}
async function reclaim(path) {
  const observed = await readLock(path)
  if (observed === null) return
  let alive = true
  let valid = false
  try {
    const previous = JSON.parse(observed)
    valid = Number.isInteger(previous.pid) && previous.pid > 0
    if (valid) process.kill(previous.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') alive = false
  }
  try {
    const info = await stat(path)
    const stale = Date.now() - info.mtimeMs > staleMs
    if (
      ((!alive && (path === admissionPath || stale)) || (!valid && stale)) &&
      observed === (await readLock(path))
    ) {
      await unlink(path)
      output({ heavyLock: 'removed-stale', slot: path, previous: observed })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
async function release() {
  clearInterval(heartbeat)
  const current = await readLock()
  if (current !== null && JSON.parse(current).id === owner.id) await unlink(lockPath)
}
function run(exe, argv, capture = false) {
  if (cancelled) throw new Error('Heavy step cancelled')
  return new Promise((resolve, reject) => {
    child = spawn(exe, argv, {
      cwd,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (data) => {
        stdout += data
      })
      child.stderr.on('data', (data) => {
        stderr += data
      })
    }
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      child = null
      resolve({ code, signal, stdout, stderr })
    })
  })
}
async function resourceGate() {
  const script =
    "$c=(Get-PSDrive C).Free; $samples=(Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit').CounterSamples; $used=($samples | Where-Object { $_.Path -like '*committed bytes' }).CookedValue; $limit=($samples | Where-Object { $_.Path -like '*commit limit' }).CookedValue; @{cFreeBytes=$c;commitHeadroomBytes=($limit-$used)} | ConvertTo-Json -Compress"
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    true,
  )
  if (result.code !== 0) throw new Error(`Resource counters unavailable: ${result.stderr}`)
  const values = JSON.parse(result.stdout)
  if (!Number.isFinite(values.cFreeBytes) || !Number.isFinite(values.commitHeadroomBytes)) {
    throw new Error('Resource counters did not return finite values')
  }
  output({ resourceGate: values })
  return values
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cancelled = true
    if (child !== null) child.kill(signal)
    process.exitCode = 130
  })
}

setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const cacheRoot = resolve('D:/Projects/.ari-cache')
const tempOverride = process.env.ARI_HEAVY_TEMP
if (tempOverride) {
  const cacheRelative = relative(cacheRoot, resolve(tempOverride))
  if (!isAbsolute(tempOverride) || !cacheRelative || cacheRelative.startsWith('..') || isAbsolute(cacheRelative))
    throw new Error('ARI_HEAVY_TEMP must name a directory inside the D: task cache')
}
process.env.TEMP = tempOverride ?? 'D:/Projects/.ari-cache/tmp'
await mkdir(process.env.TEMP, { recursive: true })
process.env.TMP = process.env.TEMP
process.env.npm_config_cache = 'D:/Projects/.ari-cache/npm'
process.env.ELECTRON_CACHE = 'D:/Projects/.ari-cache/electron'
process.env.ELECTRON_BUILDER_CACHE = 'D:/Projects/.ari-cache/electron-builder'
try {
  await acquire()
  heartbeat = setInterval(() => {
    void readLock()
      .then((value) => {
        if (value !== null && JSON.parse(value).id === owner.id) {
          return utimes(lockPath, new Date(), new Date())
        }
      })
      .catch((error) => output({ heartbeatError: error.message }))
  }, 60_000)
  const result = await run(executable, args)
  output({
    heavyResult: { worker, executable, args, exitCode: result.code, signal: result.signal },
  })
  process.exitCode = cancelled ? 130 : (result.code ?? 1)
} finally {
  await release()
}
