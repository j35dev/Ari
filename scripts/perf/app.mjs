/* global WebSocket, fetch, setTimeout, clearTimeout */
// Building, launching and driving one Electron instance of the app under test.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FLAGS = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]

export async function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise(
    (_, reject) =>
      (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms)),
  )
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function appDataDir() {
  if (process.platform === 'win32')
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

/** Electron binary for the worktree, running its postinstall when a fresh `pnpm install` skipped it. */
export function electronBinary(desktopDir) {
  const req = createRequire(join(desktopDir, 'package.json'))
  try {
    return req('electron')
  } catch {
    const pkg = dirname(req.resolve('electron/package.json'))
    console.log(`[perf] electron binary missing; running install.js in ${pkg}`)
    execFileSync(process.execPath, ['install.js'], { cwd: pkg, stdio: 'inherit' })
    return req('electron')
  }
}

async function newestMtime(dir) {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && !entry.parentPath.includes('node_modules'))
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs)
  }
  return newest
}

/** Builds `apps/desktop/out` when missing or forced; warns when sources are newer. */
export async function ensureBuild(appDir, force) {
  const desktop = join(appDir, 'apps', 'desktop')
  const main = join(desktop, 'out', 'main', 'index.js')
  if (force || !existsSync(main)) {
    console.log(`[perf] building ${desktop} (electron-vite build)…`)
    execFileSync('npx', ['electron-vite', 'build'], {
      cwd: desktop,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    return
  }
  const built = statSync(main).mtimeMs
  const dirs = [
    join(desktop, 'src'),
    ...(await readdir(join(appDir, 'packages'))).map((p) => join(appDir, 'packages', p, 'src')),
  ]
  const newest = Math.max(
    ...(await Promise.all(dirs.filter((d) => existsSync(d)).map(newestMtime))),
  )
  if (newest > built)
    console.warn('[perf] WARNING: sources are newer than out/ — pass --build to rebuild')
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** Minimal CDP client; `sessionId` routes a call to an attached target (flat mode). */
export async function cdp(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error(`cannot connect ${url}`)), { once: true })
  })
  let next = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data)
    if (m.id === undefined) return listeners.forEach((l) => l(m))
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`))
    else p?.resolve(m.result)
  })
  const send = (method, params = {}, sessionId, ms = 60_000) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { method, resolve, reject })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
      ms,
      method,
    )
  return { send, on: (l) => listeners.add(l), close: () => ws.close() }
}

/** Evaluates an expression (awaiting promises); throws on page exceptions. */
export async function evaluate(client, sessionId, expression, ms) {
  const r = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    ms,
  )
  if (r.exceptionDetails)
    throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

/**
 * Launches the built app under a scratch identity with CDP on the renderer
 * and the Node inspector on the main process. Main is held at its first line
 * while a session preload carrying the probe is registered, so boot marks are
 * exact; should the window exist already, the probe goes in late (flagged).
 * The dev identity in the main bundle is patched only until the window exists.
 */
export async function launch({ desktopDir, scratchName, probe, logPath, scratchDir }) {
  const mainJs = join(desktopDir, 'out', 'main', 'index.js')
  const original = readFileSync(mainJs, 'utf8')
  if (!original.includes('"Ari Dev"') && !original.includes("'Ari Dev'"))
    throw new Error(
      `no "Ari Dev" identity to patch in ${mainJs} (left patched by a killed run? rebuild with --build)`,
    )
  const port = await freePort()
  const binary = electronBinary(desktopDir)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(ARI_|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS)/.test(k),
    ),
  )
  writeFileSync(
    mainJs,
    original
      .replaceAll('Ari Dev', scratchName)
      .replaceAll('com.ari.desktop.dev', 'com.ari.desktop.perf'),
  )
  const restore = () => writeFileSync(mainJs, original)
  let spawnedAt = Date.now()
  let listeningAt = null
  const child = spawn(
    binary,
    ['.', `--remote-debugging-port=${port}`, '--inspect-brk=0', ...FLAGS],
    { cwd: desktopDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = createWriteStream(logPath, { flags: 'a' })
  child.stdout.pipe(log)
  let inspectorUrl = null
  child.stderr.on('data', (d) => {
    log.write(d)
    inspectorUrl ??= /Debugger listening on (ws:\/\/\S+)/.exec(String(d))?.[1] ?? null
    if (inspectorUrl) listeningAt ??= Date.now()
    // The main script ended while the inspector held it: the app quit at boot.
    if (String(d).includes('Waiting for the debugger to disconnect')) exited = true
  })
  let exited = false
  child.on('exit', () => (exited = true))
  const until = async (what, ms, poll) => {
    for (const t0 = Date.now(); ; await sleep(5)) {
      if (exited)
        throw new Error(
          `app quit during startup (is another instance holding the profile?) — see ${logPath}`,
        )
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`)
      const value = await poll()
      if (value) return value
    }
  }
  try {
    const main = await cdp(await until('main inspector', 30_000, () => inspectorUrl))
    // A session preload runs the probe in the page's main world before any app script.
    const preload = join(scratchDir, 'perf-probe-preload.cjs')
    writeFileSync(
      preload,
      `require('electron').contextBridge.executeInMainWorld({ func: () => {
${probe}
} })
`,
    )
    const hook = `(() => {
      const { app, webContents } = process.getBuiltinModule('node:module').createRequire(${JSON.stringify(join(desktopDir, 'package.json'))})('electron')
      if (webContents.getAllWebContents().length > 0) return 'late'
      const registered = new Set()
      app.on('web-contents-created', (_event, wc) => {
        if (registered.has(wc.session)) return
        registered.add(wc.session)
        wc.session.registerPreloadScript({ type: 'frame', id: 'ari-perf-probe', filePath: ${JSON.stringify(preload)} })
      })
      return 'hooked'
    })()`
    // --inspect-brk holds main until it is released, then breaks on the app's
    // first line, where Node is fully up but no app code has run.
    const paused = new Promise((resolve) =>
      main.on((m) => m.method === 'Debugger.paused' && resolve(Date.now())),
    )
    await main.send('Debugger.enable')
    const releasedAt = Date.now()
    await main.send('Runtime.runIfWaitingForDebugger')
    const pausedAt = await withTimeout(paused, 30_000, 'main process first-line break')
    const hookResult = await main.send('Runtime.evaluate', {
      expression: hook,
      returnByValue: true,
    })
    const hooked = hookResult.result?.value === 'hooked'
    if (!hooked)
      console.warn(
        `[perf] probe hook failed: ${JSON.stringify(hookResult.result?.description ?? hookResult.result?.value)}`,
      )
    await main.send('Debugger.resume')
    // Both holds are ours, not the app's: the launch clock skips them.
    spawnedAt += releasedAt - listeningAt + (Date.now() - pausedAt)
    await main.send('Debugger.disable')
    const version = await until('CDP endpoint', 30_000, () =>
      fetch(`http://127.0.0.1:${port}/json/version`).then(
        (r) => r.json(),
        () => null,
      ),
    )
    const browser = await cdp(version.webSocketDebuggerUrl)
    const page = new Promise((resolve) => {
      browser.on((m) => {
        const info = m.params?.targetInfo
        if (
          m.method === 'Target.attachedToTarget' &&
          info.type === 'page' &&
          !info.url.startsWith('devtools:')
        )
          resolve(m.params.sessionId)
      })
    })
    await browser.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    const sessionId = await withTimeout(page, 30_000, 'renderer page target')
    restore()
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: probe }, sessionId)
    if (!hooked) await browser.send('Runtime.evaluate', { expression: probe }, sessionId)
    return {
      pid: child.pid,
      spawnedAt,
      lateAttach: !hooked,
      browser,
      main,
      send: (method, params, ms) => browser.send(method, params, sessionId, ms),
      eval: (expression, ms) => evaluate(browser, sessionId, expression, ms),
      kill: async () => {
        browser.close()
        main.close()
        killTree(child.pid)
        for (let i = 0; i < 100 && alive(child.pid); i++) await sleep(100)
      },
    }
  } catch (error) {
    restore()
    killTree(child.pid)
    throw error
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

/** Working set / private bytes summed over the app's whole process tree. */
export function treeMemory(rootPid) {
  let rows
  if (process.platform === 'win32') {
    const json = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 64 << 20 },
    )
    rows = JSON.parse(json).map((p) => [
      p.ProcessId,
      p.ParentProcessId,
      Number(p.WorkingSetSize),
      Number(p.PrivatePageCount),
    ])
  } else {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([pid, ppid, rss]) => [pid, ppid, rss * 1024, null])
  }
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) grew = tree.add(pid)
  }
  const mine = rows.filter(([pid]) => tree.has(pid))
  const mb = (i) => Math.round(mine.reduce((a, r) => a + (r[i] ?? 0), 0) / 1048576)
  return {
    processes: mine.length,
    workingSetMB: mb(2),
    privateMB: process.platform === 'win32' ? mb(3) : null,
  }
}
