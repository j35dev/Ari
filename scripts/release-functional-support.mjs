// Test infrastructure only. Importing this file never launches Electron.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

export const FIXTURE_SHA256 = '9b34fb1c2768afc80154f0de6dcd45c9d5d550b22d9c25ce1635d7fc5d2e64ac'
export const PROVIDERS = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes']

export function normalizeScriptURL(value) {
  return decodeURIComponent(value.replace(/^file:\/\//, '').replace(/^\/([a-z]:)/i, '$1'))
    .replaceAll('\\', '/')
    .toLowerCase()
}

export function startupScriptKind(url, archive, resources) {
  const normalized = normalizeScriptURL(url)
  if (
    [archive, join(resources, 'app.asar')].some((path) =>
      normalized.startsWith(`${normalizeScriptURL(path)}/`),
    )
  )
    return 'app'
  // Electron43 NodeBindings names its framework entry electron/js2c/browser_init.
  // Do not allow arbitrary filesystem code before disposable path isolation.
  if (/^(?:node:|electron\/js2c\/)/.test(url)) return 'framework'
  return 'unknown'
}

export function contained(root, path) {
  const delta = relative(root, path)
  return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
}

export function requireHostedCI(env = process.env) {
  assert.ok(
    env.RELEASE_FUNCTIONAL_CI === '1' &&
      env.CI === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      isAbsolute(env.RUNNER_TEMP ?? ''),
    'Packaged GUI execution requires an explicitly opted-in GitHub-hosted disposable runner',
  )
}

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

export function isolatedEnvironment(root, source = process.env) {
  // Allowlist, not a blacklist: no control/provider credentials or startup overrides survive.
  const env = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appData'),
    LOCALAPPDATA: join(root, 'local'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
    TMPDIR: join(root, 'temp'),
    ARI_NO_LOGIN_SHELL: '1',
    // Only system tools can resolve; configured agent CLIs are neither on PATH nor enabled.
    PATH:
      process.platform === 'win32'
        ? join(source.SystemRoot ?? 'C:/Windows', 'System32')
        : '/usr/bin:/bin',
  }
  for (const key of ['SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY'])
    if (source[key] !== undefined) env[key] = source[key]
  return env
}

export function safeSettings(settings = {}) {
  return {
    ...settings,
    version: 1,
    providers: Object.fromEntries(
      PROVIDERS.map((kind) => [
        kind,
        {
          enabled: false,
          binaryPath: '',
          accounts: [],
          activeAccount: 'default',
        },
      ]),
    ),
    speech: { ...settings.speech, enabled: false, duckAudio: false },
    delegation: { ...settings.delegation, enabled: false },
    notifications: { settleSound: false, desktop: false, discordPresence: false },
    remote: { enabled: false, port: 8787, allowedOrigins: [] },
    sourceControl: { ...settings.sourceControl, fetchIntervalSeconds: 0 },
    window: null,
  }
}

export function relocate(value, root, token = '{{PROFILE_ROOT}}') {
  if (typeof value === 'string' && value.startsWith(token)) {
    const parts = value
      .slice(token.length)
      .split(/[\\/]+/)
      .filter(Boolean)
    assert.ok(
      parts.every((part) => part !== '.' && part !== '..' && !part.includes(':')),
      'Unsafe relocated path',
    )
    return join(root, ...parts)
  }
  if (Array.isArray(value)) return value.map((item) => relocate(item, root, token))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relocate(item, root, token)]),
    )
  return value
}

export async function prepareProfile(root, fixturePath) {
  // Caller creates a new mkdtemp root; never prepare a live/existing application profile.
  assert.ok(
    isAbsolute(root) && (await readdir(root)).length === 0,
    'Profile preparation requires a fresh empty absolute directory',
  )
  const receipt = {
    kind: fixturePath ? 'frozen-0312-copy' : 'clean-safety-profile',
    relocated: [],
    overlays: [],
  }
  let fixture = null
  if (fixturePath) {
    assert.equal(await sha256(fixturePath), FIXTURE_SHA256, 'Frozen fixture hash mismatch')
    fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
    assert.equal(fixture.source.version, '0.3.12')
    assert.equal(fixture.pathToken, '{{PROFILE_ROOT}}')
    const pathFor = (name) => {
      assert.ok(
        !isAbsolute(name) && !name.includes('\\') && !name.split('/').includes('..'),
        'Fixture path escaped root',
      )
      const path = resolve(root, name)
      assert.ok(contained(root, path) && path !== root, 'Fixture path escaped root')
      return path
    }
    for (const name of fixture.directories) await mkdir(pathFor(name), { recursive: true })
    for (const file of fixture.files) {
      const path = pathFor(file.path)
      await mkdir(resolve(path, '..'), { recursive: true })
      let bytes = file.base64 === undefined ? file.utf8 : Buffer.from(file.base64, 'base64')
      if (typeof bytes === 'string' && bytes.includes(fixture.pathToken)) {
        // Only token-bearing serialized path values change; transcript/queue bytes stay intact.
        bytes = `${JSON.stringify(relocate(JSON.parse(bytes), root), null, 2)}\n`
        receipt.relocated.push(file.path)
      }
      await writeFile(path, bytes, { flag: 'wx' })
    }
    receipt.fixtureSha256 = FIXTURE_SHA256
    receipt.source = fixture.source
  }
  const profile = join(root, 'profile')
  await mkdir(profile, { recursive: true })
  const settings = fixture ? JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')) : {}
  await writeFile(
    join(profile, 'settings.json'),
    `${JSON.stringify(safeSettings(settings), null, 2)}\n`,
  )
  await writeFile(join(profile, 'resume-schedule.json'), '[]\n')
  receipt.overlays = [
    'providers disabled/empty accounts',
    'speech/ducking disabled',
    'delegation disabled',
    'notifications/remote disabled',
    'Git fetch disabled',
    'window bounds reset',
    'resume schedule cleared in copy',
  ]
  return { profile, fixture, receipt }
}

export function updaterConfig(text) {
  assert.ok(Buffer.byteLength(text) < 4096, 'Unexpectedly large updater configuration')
  const fields = {}
  for (const key of ['provider', 'owner', 'repo']) {
    const matches = [...text.matchAll(new RegExp(`^${key}:\\s*([^\\r\\n]+)$`, 'gm'))]
    assert.equal(matches.length, 1, `Missing/ambiguous packaged updater ${key}`)
    let value = matches[0][1].trim()
    if (value.startsWith('"')) value = JSON.parse(value)
    else if (value.startsWith("'")) {
      assert.ok(value.endsWith("'"), 'Unsupported updater YAML scalar')
      value = value.slice(1, -1).replaceAll("''", "'")
    }
    fields[key] = value
  }
  assert.deepEqual(
    fields,
    { provider: 'github', owner: 'j35dev', repo: 'Ari' },
    'Packaged updater target mismatch',
  )
  return fields
}

export async function poll(label, read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await read()
    if (value) return value
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

export async function bounded(promise, label, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function debuggerTargets(port) {
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: globalThis.AbortSignal.timeout(1000),
  })
  assert.ok(response.ok, 'Debugger target discovery failed')
  return response.json()
}

export async function pauseBeforeArchivedApp(client, archive, resources, trace = []) {
  // Use the existing pause wait's 20s as one monotonic bootstrap budget,
  // rather than imposing a module-count limit or restarting it after progress.
  const budget = 'Framework bootstrap time budget (20000ms)'
  const deadline = performance.now() + 20_000
  const remaining = () => {
    const milliseconds = deadline - performance.now()
    assert.ok(milliseconds > 0, `${budget} exhausted`)
    return milliseconds
  }
  const send = (method, params) => client.send(method, params, Math.min(10_000, remaining()))
  const runUntilPause = async (method) => {
    let listener
    const paused = new Promise((resolve) => {
      listener = resolve
      client.once('Debugger.paused', listener)
    })
    try {
      await send(method)
      return await bounded(paused, budget, remaining())
    } finally {
      client.off('Debugger.paused', listener)
    }
  }
  // Node/Electron script URLs use physical paths (macOS /private/var), even
  // when the selected archive was supplied through an alias (/var).
  ;[archive, resources] = await bounded(
    Promise.all([realpath(archive), realpath(resources)]),
    budget,
    remaining(),
  )
  const scripts = [],
    scriptURLs = new Map()
  client.on('Debugger.scriptParsed', ({ url, scriptId }) => {
    if (scripts.length < 5000) {
      scripts.push(url)
      scriptURLs.set(scriptId, url)
    }
  })
  await send('Runtime.enable')
  await send('Debugger.enable')
  assert.ok(
    !scripts.some((url) => /\.asar(?:[\\/]|$)/i.test(url)),
    'Packaged code loaded before disposable path isolation',
  )
  const { breakpointId } = await send('Debugger.setInstrumentationBreakpoint', {
    instrumentation: 'beforeScriptExecution',
  })
  let pause = await runUntilPause('Runtime.runIfWaitingForDebugger')
  const seenPauses = new Set()
  // Electron bootstrap sets up public APIs and package name/version before app
  // import. Only known framework scripts may execute before the isolation pause.
  for (;;) {
    remaining()
    const location = pause.callFrames[0]?.location
    const url = scriptURLs.get(location?.scriptId) ?? pause.callFrames[0]?.url ?? ''
    let kind = startupScriptKind(url, archive, resources)
    let internalGlobalSource
    if (
      url === 'evalmachine.<anonymous>' &&
      pause.callFrames.some(
        (frame) =>
          frame.functionName === 'getInternalGlobal' &&
          scriptURLs.get(frame.location.scriptId) === 'node:internal/util',
      )
    ) {
      const { scriptSource } = await send('Debugger.getScriptSource', {
        scriptId: location.scriptId,
      })
      internalGlobalSource = scriptSource.slice(0, 2000)
      if (scriptSource === 'this') kind = 'framework'
    }
    trace.push({
      kind,
      url,
      reason: pause.reason,
      location,
      internalGlobalSource,
      callers: pause.callFrames.slice(1, 5).map((frame) => ({
        functionName: frame.functionName,
        url: scriptURLs.get(frame.location.scriptId) ?? frame.url,
      })),
    })
    assert.notEqual(
      kind,
      'unknown',
      `Unknown code before disposable isolation; do not resume: ${url || '(empty script URL)'}`,
    )
    if (kind === 'app') {
      assert.ok(
        ['instrumentation', 'Break on start'].includes(pause.reason),
        'No proven pre-execution isolation boundary',
      )
      // Our evaluation must not trigger a nested instrumentation pause.
      await send('Debugger.removeBreakpoint', { breakpointId })
      return { scripts, trace }
    }
    const key = JSON.stringify([
      location?.scriptId,
      location?.lineNumber,
      location?.columnNumber,
      pause.reason,
    ])
    assert.ok(
      !seenPauses.has(key),
      `Framework bootstrap made no progress: repeated pause at ${url}`,
    )
    seenPauses.add(key)
    pause = await runUntilPause('Debugger.resume')
  }
}

export class CDP extends EventEmitter {
  static async connect(url, timeoutMs = 5000) {
    const address = new URL(url)
    assert.ok(
      address.protocol === 'ws:' && address.hostname === '127.0.0.1',
      'Debugger must stay on loopback',
    )
    const ws = new globalThis.WebSocket(url)
    const client = new CDP(ws)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('Debugger connection timed out'))
      }, timeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Debugger connection failed'))
        },
        { once: true },
      )
    })
    return client
  }
  constructor(ws) {
    super()
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener('message', ({ data }) => {
      try {
        const message = JSON.parse(data)
        if (message.id) {
          const pending = this.pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
          else pending.resolve(message.result)
        } else this.emit(message.method, message.params)
      } catch (error) {
        this.fail(error)
      }
    })
    ws.addEventListener('close', () => this.fail(new Error('Debugger disconnected')))
    ws.addEventListener('error', () => this.fail(new Error('Debugger transport error')))
  }
  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  send(method, params = {}, timeoutMs = 10_000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  async evaluate(expression, timeoutMs = 10_000, awaitPromise = true) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      timeoutMs,
    )
    assert.ok(
      !result.exceptionDetails,
      `Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`,
    )
    return result.result.value
  }
  close() {
    this.fail(new Error('Debugger closed by harness'))
    this.ws.close()
  }
}
