import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createLogger } from '@ari/shared/logger'
import { buildShellSpawnArgs, needsWindowsShell } from './spawn-cli'
import { interruptChild } from './teardown'

const log = createLogger('providers:off-thread')

/**
 * Runs short commands (a CLI's `--version`, an updater's `--check`) on a worker
 * thread and collects their output. Starting a process blocks the thread that
 * starts it on Windows, for seconds with some large single-file CLIs, and these
 * commands would otherwise start on Ari's main thread, which also keeps the
 * window responsive. Only long-lived connections (agent sessions) need their
 * process on the main thread; one-shot commands never do.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const LIMIT = 64 * 1024
// A command behind a cmd.exe shim is the shim's child: only a tree kill,
// while the shim still lives, reaches it.
const killTree = (child) => {
  try {
    if (process.platform === 'win32' && child.pid)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    else child.kill('SIGKILL')
  } catch {}
}
parentPort.on('message', ({ id, file, args, verbatim, env, timeoutMs }) => {
  let stdout = ''
  let settled = false
  const done = (result) => {
    if (settled) return
    settled = true
    parentPort.postMessage({ id, result })
  }
  let child
  try {
    child = spawn(file, args, {
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      ...(env ? { env } : {}),
    })
  } catch (error) {
    done({ error: String(error) })
    return
  }
  child.on('error', () => done({ code: null, stdout: '' }))
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-LIMIT) })
  child.on('close', (code) => done({ code, stdout }))
  setTimeout(() => {
    if (settled) return
    killTree(child)
    done({ code: null, stdout: '' })
  }, timeoutMs).unref()
})
`

/** What a captured run produced; `error` means the process could not be started. */
export interface CapturedRun {
  code?: number | null
  stdout?: string
  error?: string
}

let worker: Worker | null = null
let workerFailed = false
let nextId = 0
const pending = new Map<number, (result: CapturedRun | null) => void>()

function runner(): Worker | null {
  if (worker !== null || workerFailed) return worker
  try {
    const started = new Worker(WORKER_SOURCE, { eval: true })
    // Never keeps Ari (or a test run) alive on its own.
    started.unref()
    started.on('message', ({ id, result }: { id: number; result: CapturedRun }) => {
      pending.get(id)?.(result)
      pending.delete(id)
    })
    const lost = (): void => {
      if (worker === started) worker = null
      for (const resolve of pending.values()) resolve(null)
      pending.clear()
    }
    started.on('error', (error) => {
      log.warn('command worker failed; running commands in process', { error: String(error) })
      workerFailed = true
      lost()
    })
    started.on('exit', lost)
    worker = started
    return started
  } catch (error) {
    log.warn('command worker unavailable; running commands in process', { error: String(error) })
    workerFailed = true
    return null
  }
}

/** The command line to start, wrapped for cmd.exe or PowerShell when Windows needs it. */
function commandLine(
  file: string,
  args: readonly string[],
): { file: string; args: string[]; verbatim: boolean } {
  if (!needsWindowsShell(file)) return { file, args: [...args], verbatim: false }
  const wrapped = buildShellSpawnArgs(file, [...args])
  return {
    file: wrapped.file,
    args: wrapped.args,
    verbatim: wrapped.windowsVerbatimArguments === true,
  }
}

/**
 * Runs `file args` to completion off the main thread and returns its exit code
 * and stdout (the last 64 KB). Null means the worker went away mid-run.
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CapturedRun | null> {
  const line = commandLine(file, args)
  const active = runner()
  if (active === null) return runHere(line, options)
  return new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    active.postMessage({ id, ...line, env: options.env, timeoutMs: options.timeoutMs })
  })
}

/** The same run on the calling thread, for when no worker can be started. */
function runHere(
  line: { file: string; args: string[]; verbatim: boolean },
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CapturedRun> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (result: CapturedRun): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    let child: ChildProcess
    try {
      child = spawn(line.file, line.args, {
        windowsVerbatimArguments: line.verbatim,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      })
    } catch (error) {
      done({ error: String(error) })
      return
    }
    child.on('error', () => done({ code: null, stdout: '' }))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-64 * 1024)
    })
    child.on('close', (code) => done({ code, stdout }))
    setTimeout(() => {
      if (!settled) {
        // A bare kill() would end only a cmd.exe shim, not the command in it.
        interruptChild(child)
        done({ code: null, stdout: '' })
      }
    }, options.timeoutMs).unref?.()
  })
}
