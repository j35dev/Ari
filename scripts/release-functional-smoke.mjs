// CI-only real packaged main/preload/renderer smoke. No production test mode.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import {
  CDP,
  PROVIDERS,
  contained,
  bounded,
  debuggerTargets,
  isolatedEnvironment,
  poll,
  prepareProfile,
  requireHostedCI,
  sha256,
  pauseBeforeArchivedApp,
  normalizeScriptURL,
  updaterConfig,
} from './release-functional-support.mjs'

// Evaluated synchronously at a beforeScriptExecution instrumentation pause.
// Awaiting a promise while V8 is paused would deadlock; this function has no awaits.
export function configureMain(options) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  check(process.versions.electron, 'Main inspector is not Electron')
  const require = process.getBuiltinModule('module').createRequire(process.execPath)
  const { app, BrowserWindow, session } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  const crypto = require('node:crypto')
  check(
    !app.isReady() && BrowserWindow.getAllWindows().length === 0,
    'Too late to isolate packaged startup',
  )
  check(app.isPackaged && process.arch === options.arch, 'Wrong packaged binary/architecture')
  check(
    fs.realpathSync(process.resourcesPath) === fs.realpathSync(options.resources),
    'Wrong packaged resources',
  )
  app.setName(options.name)
  if (process.platform === 'win32') app.setAppUserModelId(`com.ari.functional.${options.name}`)
  for (const [key, value] of Object.entries({
    home: path.join(options.root, 'home'),
    appData: path.join(options.root, 'appData'),
    userData: options.profile,
    sessionData: path.join(options.root, 'sessionData'),
    temp: options.temp,
    logs: path.join(options.root, 'logs'),
    crashDumps: path.join(options.root, 'crashes'),
  })) {
    fs.mkdirSync(value, { recursive: true })
    app.setPath(key, value)
    check(app.getPath(key) === value, `Failed disposable ${key}`)
  }
  const packaged = JSON.parse(fs.readFileSync(path.join(options.archive, 'package.json'), 'utf8'))
  check(
    packaged.version === options.version && packaged.main === './out/main/index.js',
    'Unexpected packaged entry',
  )
  const receipt = (globalThis.__ariFunctional = {
    kind: 'release-functional-main',
    electron: process.versions.electron,
    arch: process.arch,
    version: packaged.version,
    name: options.name,
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    errors: [],
    deniedRequests: 0,
    ready: false,
    quitting: false,
    bundleHashes: Object.fromEntries(
      ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map((file) => [
        file,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(options.archive, file)))
          .digest('hex'),
      ]),
    ),
  })
  const error = (kind, details) => {
    if (receipt.errors.length < 20)
      receipt.errors.push({ kind, details: String(details).slice(0, 2000) })
  }
  process.on('uncaughtExceptionMonitor', (cause) =>
    error('uncaughtException', cause.stack ?? cause),
  )
  const denyPermissions = (contents) => {
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    contents.session.setPermissionCheckHandler(() => false)
  }
  app.once('ready', () => {
    // HTTP(S)/WS renderer and Electron net requests, including updater checks, are denied.
    // This is not a claim that arbitrary Node transports are sandboxed.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => {
        receipt.deniedRequests++
        callback({ cancel: true })
      },
    )
    receipt.ready = true
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.setAudioMuted(true)
    contents.on('preload-error', (_event, preload, cause) =>
      error('preload-error', `${preload}: ${cause}`),
    )
    contents.on('render-process-gone', (_event, details) => {
      if (!receipt.quitting) error('render-process-gone', JSON.stringify(details))
    })
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3 && !receipt.quitting)
        error('did-fail-load', `${code}: ${description}`)
    })
    // Reapply after Ari's ordinary speech permission registration; speech is disabled on disk.
    contents.on('did-finish-load', () => denyPermissions(contents))
  })
  app.on('before-quit', () => {
    receipt.quitting = true
  })
  app.once('will-quit', () => {
    process.stdout.write(
      `\n${JSON.stringify({ ...receipt, kind: 'release-functional-shutdown', willQuit: true })}\n`,
    )
  })
  return receipt
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

export function launchCommand(
  executable,
  arch,
  mainPort,
  rendererPort,
  platform = process.platform,
  hostArch = process.arch,
) {
  const args = [
    `--inspect-brk=127.0.0.1:${mainPort}`,
    `--remote-debugging-port=${rendererPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--mute-audio',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-geolocation',
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ]
  return platform === 'darwin' && arch !== hostArch
    ? { file: '/usr/bin/arch', args: [arch === 'x64' ? '-x86_64' : '-arm64', executable, ...args] }
    : { file: executable, args }
}

const rpcExpression = (method, params) =>
  `window.ari.invoke(${JSON.stringify(method)}, ${params === undefined ? 'undefined' : JSON.stringify(params)})`
// The splash is a fixed overlay, not hidden or inert, so shell rects stay nonempty under it.
export function startupOverlay(document) {
  return Boolean(
    document.documentElement?.hasAttribute('data-ari-booting') ||
    document.querySelector('.ari-awaken'),
  )
}
export function intendedSurface(element) {
  if (!element || element.closest('[hidden], [inert]')) return false
  if (element.getClientRects().length === 0) return false
  const doc = element.ownerDocument
  // This function is serialized into CDP renderer expressions; keep it self-contained.
  if (doc.documentElement?.hasAttribute('data-ari-booting') || doc.querySelector('.ari-awaken'))
    return false
  const rect = element.getBoundingClientRect()
  const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return hit === element || Boolean(hit && element.contains(hit))
}
const visible = intendedSurface.toString()
async function click(renderer, selector, text) {
  await poll(`visible clickable ${selector}`, () =>
    renderer.evaluate(`(() => {
    const found = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible})
      .filter(el => ${text ? `el.innerText.includes(${JSON.stringify(text)})` : 'true'});
    if (found.length !== 1) return false;
    found[0].click(); return true;
  })()`),
  )
}
async function screenshot(renderer, root, name) {
  if (name !== 'failure') {
    assert.equal(
      await renderer.evaluate(`(${startupOverlay.toString()})(document)`),
      false,
      'Startup splash still covers the intended surface',
    )
  }
  const { data } = await renderer.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  assert.ok(data.length > 100, 'Empty renderer screenshot')
  await writeFile(join(root, `${name}.png`), Buffer.from(data, 'base64'))
}
async function pageReady(renderer) {
  return poll(
    'painted packaged renderer and preload',
    () =>
      renderer.evaluate(`(() => {
    if ((${startupOverlay.toString()})(document)) return false;
    if (document.readyState !== 'complete' || typeof window.ari?.invoke !== 'function') return false;
    const paint = performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint');
    return paint && document.querySelector('#root')?.textContent.length > 0
      ? { url: location.href, firstContentfulPaintMs: paint.startTime, title: document.title } : false;
  })()`),
    30_000,
  )
}

async function reload(renderer) {
  const previous = await renderer.evaluate('performance.timeOrigin')
  await renderer.send('Page.reload')
  await poll('new renderer document', () =>
    renderer.evaluate(`performance.timeOrigin !== ${previous}`),
  )
  return pageReady(renderer)
}

export function assertCleanExit(exit, stdout, stderr) {
  assert.ok(!exit.timedOut && !exit.forced, 'Packaged process required forced/timeout shutdown')
  assert.equal(exit.code, 0, `Packaged exit: ${JSON.stringify(exit)}`)
  assert.equal(exit.signal, null, `Packaged shutdown signal: ${exit.signal}`)
  assert.ok(
    !/shutdown deadline reached|shutdown failed|runtime resource failed to close|desktop startup failed|main window failed to load/.test(
      `${stdout}\n${stderr}`,
    ),
    'Packaged startup/shutdown reported a failure',
  )
  const shutdown = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value.kind === 'release-functional-shutdown' ? [value] : []
    } catch {
      return []
    }
  })
  assert.equal(shutdown.length, 1, 'Missing/ambiguous real will-quit receipt')
  assert.ok(shutdown[0].willQuit && shutdown[0].ready)
  assert.deepEqual(shutdown[0].errors, [], 'Packaged main/preload/renderer reported errors')
  return shutdown[0]
}

// Electron 43.4.1 keeps the configured preload outside last Blink preferences.
// Pinned test instrumentation: shell/browser/api/electron_api_web_contents.cc
// GetPreloadScript/_getPreloadScript and shell/browser/preload_script.cc filePath.
// The renderer bridge/RPC and archived preload hash are checked separately.
export function observeWindow(window, electronVersion) {
  if (electronVersion !== '43.4.1' || typeof window.webContents._getPreloadScript !== 'function')
    throw new Error('Unsupported pinned Electron preload observation')
  const preload = window.webContents._getPreloadScript()
  if (typeof preload?.filePath !== 'string' || !preload.filePath || preload.type !== 'frame')
    throw new Error('Missing configured frame preload')
  return {
    url: window.webContents.getURL(),
    preferences: window.webContents.getLastWebPreferences(),
    preload: preload.filePath,
  }
}

export async function profileTemporaryDirectory(root, runnerRoot, platform = process.platform) {
  if (platform !== 'linux') return join(root, 'temp')
  // Chromium appends scoped_dirXXXXXX/SingletonSocket to TMPDIR. A deep evidence
  // path exceeds Linux sockaddr_un's 108-byte bound before the renderer starts.
  const runner = await realpath(runnerRoot)
  const temp = await realpath(await mkdtemp(join(runner, 'aft-')))
  assert.ok(contained(runner, temp) && temp !== runner, 'Temporary directory escaped runner')
  assert.ok(
    Buffer.byteLength(join(temp, 'scoped_dirXXXXXX', 'SingletonSocket')) < 108,
    'Disposable Chromium socket path exceeds Linux limit',
  )
  return temp
}

async function runProfile(options, suiteRoot, fixturePath) {
  const root = await mkdtemp(join(suiteRoot, fixturePath ? 'frozen-' : 'clean-'))
  const { profile, fixture, receipt: preparation } = await prepareProfile(root, fixturePath)
  const env = isolatedEnvironment(root)
  const temp = await profileTemporaryDirectory(root, process.env.RUNNER_TEMP)
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) env[key] = temp
  await mkdir(temp, { recursive: true })
  for (const value of new Set(
    Object.values(env).filter((value) => isAbsolute(value) && contained(root, value)),
  ))
    await mkdir(value, { recursive: true })
  const mainPort = await freePort()
  const rendererPort = await freePort()
  const command = launchCommand(options.executable, options.arch, mainPort, rendererPort)
  const receipt = { preparation, root, temp, command, stages: [], observed: false }
  let main, renderer, child, exitPromise, lifetime
  let stdout = '',
    stderr = '',
    forced = false,
    timedOut = false
  let outputTruncated = false
  const startedAt = Date.now()
  let failure = null
  const cap = (text) => {
    if (text.length > 1024 * 1024) outputTruncated = true
    return text.slice(-1024 * 1024)
  }
  try {
    child = spawn(command.file, command.args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    exitPromise = new Promise((resolve) => {
      child.once('error', (error) =>
        resolve({ spawnError: String(error), code: null, signal: null }),
      )
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    child.stdout.on('data', (bytes) => {
      stdout = cap(stdout + bytes)
    })
    child.stderr.on('data', (bytes) => {
      stderr = cap(stderr + bytes)
    })
    lifetime = setTimeout(() => {
      timedOut = true
      forced = true
      child.kill('SIGKILL')
    }, 90_000)
    const discover = (port, predicate) =>
      poll(`debugger ${port}`, async () => {
        assert.ok(
          !timedOut && child.exitCode === null && child.signalCode === null,
          'Packaged process ended before readiness',
        )
        try {
          return (await debuggerTargets(port)).find(predicate) ?? false
        } catch (error) {
          if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return false
          throw error
        }
      })
    const target = await discover(mainPort, (target) => target.type === 'node')
    main = await CDP.connect(target.webSocketDebuggerUrl)
    receipt.bootstrapPauses = []
    const { scripts } = await pauseBeforeArchivedApp(
      main,
      options.archive,
      options.resources,
      receipt.bootstrapPauses,
    )
    receipt.isolation = await main.evaluate(
      `(${configureMain.toString()})(${JSON.stringify({
        ...options,
        profile,
        root,
        temp,
        name: `AriFunctional-${randomUUID()}`,
      })})`,
      10_000,
      false,
    )
    receipt.stages.push('isolated before archived app scripts')
    main.on('Debugger.paused', () => {
      void main.send('Debugger.resume').catch((error) => {
        failure ??= error
      })
    })
    await main.send('Debugger.resume')
    // These values are booleans or a plain object. awaitPromise would wait on the
    // paused #asyncInstantiate job and can reject -32000 before main is observable.
    await poll(
      'real packaged main ready',
      () => main.evaluate('globalThis.__ariFunctional.ready', 10_000, false),
      30_000,
    )
    await poll('packaged window created', () =>
      main.evaluate(
        `process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows().length > 0`,
        10_000,
        false,
      ),
    )
    const normalized = normalizeScriptURL
    assert.ok(
      scripts.some((url) =>
        normalized(url).endsWith(`${normalized(options.archive)}/out/main/index.js`),
      ),
      'Selected archived production main did not execute',
    )
    receipt.main = await main.evaluate(
      `(() => {
      const { app, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const windows = BrowserWindow.getAllWindows();
      return { ...globalThis.__ariFunctional, isPackaged: app.isPackaged, appVersion: app.getVersion(),
        userData: app.getPath('userData'), name: app.getName(),
        windows: windows.map(w => (${observeWindow.toString()})(w, process.versions.electron)) };
    })()`,
      10_000,
      false,
    )
    assert.ok(receipt.main.isPackaged)
    assert.equal(receipt.main.appVersion, options.version)
    assert.equal(receipt.main.userData, profile)
    assert.equal(receipt.main.name, receipt.isolation.name, 'Bootstrap overwrote isolated identity')
    assert.equal(
      receipt.main.windows.length,
      1,
      'Unexpected startup window (speech/widget must stay off)',
    )
    const preferences = receipt.main.windows[0].preferences
    assert.ok(preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration)
    assert.equal(
      normalized(receipt.main.windows[0].preload),
      `${normalized(options.archive)}/out/preload/index.cjs`,
    )
    const page = await discover(
      rendererPort,
      (target) =>
        target.type === 'page' &&
        normalized(target.url).endsWith(`${normalized(options.archive)}/out/renderer/index.html`),
    )
    renderer = await CDP.connect(page.webSocketDebuggerUrl)
    const rendererErrors = []
    renderer.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      if (rendererErrors.length < 20) rendererErrors.push(exceptionDetails)
    })
    await renderer.send('Runtime.enable')
    await renderer.send('Page.enable')
    receipt.paint = await pageReady(renderer)
    await screenshot(renderer, root, '01-startup')
    const [settings, projects, sessions] = await Promise.all(
      ['settings.get', 'project.list', 'session.list'].map((method) =>
        renderer.evaluate(rpcExpression(method)),
      ),
    )
    assert.ok(Array.isArray(projects) && Array.isArray(sessions), 'Startup listing RPCs failed')
    for (const kind of PROVIDERS) assert.equal(settings.providers[kind].enabled, false)
    assert.ok(!settings.speech.enabled && !settings.remote.enabled && !settings.delegation.enabled)
    receipt.rpc = {
      methods: ['settings.get', 'project.list', 'session.list'],
      projects: projects.length,
      sessions: sessions.length,
    }
    let sessionId,
      title,
      expectedDraft = ''
    if (fixture) {
      sessionId = fixture.expected.parentId
      title = 'Synthetic upgrade conversation'
      assert.ok(
        sessions.some((session) => session.id === sessionId),
        'Frozen saved chat missing',
      )
      assert.ok(
        projects.some((project) => project.id === fixture.expected.projectId),
        'Frozen saved project missing',
      )
      assert.equal(settings.appearance.themeId, 'graphite')
      assert.equal(settings.appearance.fontSize, 15)
      assert.equal(settings.sessions.defaultPermissionMode, 'ask')
      expectedDraft = JSON.parse(fixture.rendererStorage['ari.drafts'])[sessionId]
      const { identifier } = await renderer.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `for (const [key,value] of Object.entries(${JSON.stringify(fixture.rendererStorage)})) localStorage.setItem(key,value)`,
      })
      receipt.rendererStorage =
        'Imported frozen writer fragments before renderer hydration; not installer/Chromium LevelDB migration'
      await reload(renderer)
      await renderer.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    } else {
      await poll('clean onboarding', () =>
        renderer.evaluate(`(() => {
          if ((${startupOverlay.toString()})(document)) return false;
          return document.body.innerText.includes('Meet your coding agents.');
        })()`),
      )
      receipt.cleanOnboardingObserved = true
      await renderer.evaluate(
        rpcExpression('settings.update', { onboarding: { completedAt: Date.now() } }),
      )
      const workspace = join(root, 'workspaces', 'clean')
      await mkdir(workspace, { recursive: true })
      const project = await renderer.evaluate(
        rpcExpression('project.open', { path: workspace, name: 'Functional smoke workspace' }),
      )
      assert.equal(project.status, 'ok', 'Disposable workspace could not be opened')
      title = 'Functional smoke saved chat'
      ;({ sessionId } = await renderer.evaluate(
        rpcExpression('session.create', {
          projectId: project.id,
          title,
          driverKind: 'codex',
          modelId: null,
          permissionMode: 'ask',
        }),
      ))
      receipt.cleanPreparation =
        'Observed setup, then completed via settings RPC and created saved project/chat via real RPC; no turn submitted'
      await reload(renderer)
    }
    const selectChat = async () => {
      await click(renderer, 'nav[aria-label="Sessions"] button[draggable="true"]', title)
      await poll('selected saved chat composer', () =>
        renderer.evaluate(`(() => {
        const el = [...document.querySelectorAll('textarea[aria-label="Message"]')].find(${visible});
        return el && el.value === ${JSON.stringify(expectedDraft)};
      })()`),
      )
      if (fixture)
        // Composer drafts hydrate before the independent replayed history stream.
        // Observe the saved response within the existing poll/lifetime budgets.
        await poll('saved transcript rendered', () =>
          renderer.evaluate(`(() => {
            if ((${startupOverlay.toString()})(document)) return false;
            return document.body.innerText.includes('Synthetic transcript response');
          })()`),
        )
    }
    await selectChat()
    await screenshot(renderer, root, '02-chat')
    await click(renderer, 'nav[aria-label="Workspace"] button[aria-label="Settings"]')
    await poll('Settings mounted', () =>
      renderer.evaluate(`(() => {
        const el = document.querySelector('nav[aria-label="Settings sections"]');
        return (${intendedSurface.toString()})(el);
      })()`),
    )
    await screenshot(renderer, root, '03-settings')
    await click(renderer, 'button[aria-label="Close settings"]')
    await selectChat()
    await click(renderer, 'nav[aria-label="Workspace"] button[aria-label^="Review changes"]')
    await poll('Changes mounted and read settled', () =>
      renderer.evaluate(`(() => {
        const view = document.querySelector('[aria-label="Source control view"]');
        return (${intendedSurface.toString()})(view) &&
          document.querySelector('#scm-tab-changes')?.getAttribute('aria-selected') === 'true' &&
          !document.body.innerText.includes('Reading repository…');
      })()`),
    )
    await screenshot(renderer, root, '04-changes')
    await click(renderer, 'button[aria-label="Close source control"]')
    await selectChat()
    await screenshot(renderer, root, '05-returned-chat')
    receipt.stages.push(
      'real first paint and preload IPC RPCs',
      'saved chat → Settings → chat → Changes → chat',
    )
    receipt.chat = { sessionId, title, draftRetained: true, transcriptObserved: Boolean(fixture) }
    if (fixture) {
      const storage = await renderer.evaluate(
        'Object.fromEntries(["ari.drafts","ari.composer-recovery"].map(k => [k,localStorage.getItem(k)]))',
      )
      assert.equal(JSON.parse(storage['ari.drafts'])[sessionId], expectedDraft)
      const intent = JSON.parse(storage['ari.composer-recovery']).sessions[sessionId]
      for (const id of ['send_preparing', 'send_pending'])
        assert.ok(
          intent.recoveries.some((item) => item.id === id),
          `Lost saved recovery ${id}`,
        )
      assert.ok(
        intent.images.some((image) => image.ref?.id === fixture.expected.attachment.id),
        'Lost saved attachment intent',
      )
      receipt.chat.recoveriesRetained = true
      assert.equal(
        await sha256(fixturePath),
        preparation.fixtureSha256,
        'Immutable frozen fixture changed',
      )
    }
    assert.deepEqual(rendererErrors, [], 'Renderer runtime exceptions')
    receipt.observed = true
  } catch (error) {
    failure ??= error
    if (renderer) {
      try {
        await screenshot(renderer, root, 'failure')
      } catch (captureError) {
        receipt.failureCapture = String(captureError)
      }
    }
  } finally {
    renderer?.close()
    if (main && receipt.isolation) {
      try {
        // Let evaluation return and disconnect inspector before the real quit completes.
        await main.evaluate(
          "(() => { const { app } = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); setTimeout(() => app.quit(), 100); return 'quit scheduled'; })()",
          2000,
          false,
        )
      } catch (error) {
        failure ??= error
      }
      main.close()
    } else if (child && exitPromise && child.exitCode === null && child.signalCode === null) {
      // An isolation failure must never resume unknown application code when
      // the debugger disconnects. Terminate only our own paused CI child first.
      forced = true
      child.kill('SIGKILL')
      try {
        await bounded(exitPromise, 'failed-isolation child close', 5000)
      } catch (error) {
        failure ??= error
        receipt.missingClose = true
      }
      main?.close()
    }
    if (exitPromise) {
      const shutdownTimeout = setTimeout(() => {
        forced = true
        child.kill('SIGKILL')
      }, 10_000)
      let exit
      try {
        exit = await bounded(exitPromise, 'packaged shutdown close', 12_000)
      } catch (error) {
        failure ??= error
        forced = true
        child.kill('SIGKILL')
        exit = { code: null, signal: null, closeMissing: true }
      }
      receipt.exit = {
        ...exit,
        forced,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        lifetimeMs: 90_000,
        shutdownTimeoutMs: 10_000,
      }
      clearTimeout(shutdownTimeout)
      clearTimeout(lifetime)
      try {
        receipt.shutdown = assertCleanExit(receipt.exit, stdout, stderr)
      } catch (error) {
        failure ??= error
      }
    }
    receipt.failure = failure ? { message: String(failure), stack: failure.stack } : null
    receipt.outputTruncated = outputTruncated
    if (outputTruncated) {
      failure ??= new Error('Packaged logs exceeded evidence bound')
      receipt.failure = { message: String(failure), stack: failure.stack }
    }
    await Promise.all([
      writeFile(join(root, 'stdout.log'), stdout),
      writeFile(join(root, 'stderr.log'), stderr),
      writeFile(join(root, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`),
    ])
  }
  assert.ok(!failure, `Functional profile failed; retained ${root}/receipt.json: ${failure}`)
  return receipt
}

export async function smoke(options) {
  requireHostedCI() // First operation: no filesystem preparation or launch on a local host.
  const { version, arch } = options
  for (const key of ['executable', 'resources', 'archive', 'fixture', 'dataRoot'])
    assert.ok(
      isAbsolute(options[key]),
      'Absolute reviewed artifact/fixture/evidence paths required',
    )
  assert.match(options.sourceHead ?? '', /^[a-f0-9]{40}$/i, 'Exact reviewed source head required')
  assert.equal(version, '0.3.13', 'This harness is scoped to candidate 0.3.13')
  assert.ok(['x64', 'arm64'].includes(arch))
  const [runnerRoot, outputRoot, executable, resources, archive, fixture] = await Promise.all([
    realpath(process.env.RUNNER_TEMP),
    realpath(options.dataRoot),
    realpath(options.executable),
    realpath(options.resources),
    realpath(options.archive),
    realpath(options.fixture),
  ])
  options = { ...options, executable, resources, archive, fixture, dataRoot: outputRoot }
  assert.ok(
    contained(runnerRoot, outputRoot),
    'Evidence/profile root must be on disposable RUNNER_TEMP',
  )
  assert.ok(contained(resources, archive), 'Archive escaped selected resources')
  const bootstrap = join(resources, 'app.asar')
  for (const [path, hash] of [
    [executable, options.executableSha256],
    [archive, options.asarSha256],
    [bootstrap, options.bootstrapSha256],
  ]) {
    assert.match(
      hash ?? '',
      /^[a-f0-9]{64}$/i,
      'Explicit reviewed executable/archive/bootstrap hashes required',
    )
    assert.equal(await sha256(path), hash.toLowerCase(), `Artifact receipt mismatch: ${path}`)
  }
  const configPath = join(resources, 'app-update.yml')
  const update = {
    ...updaterConfig(await readFile(configPath, 'utf8')),
    sha256: await sha256(configPath),
  }
  const suiteRoot = await mkdtemp(join(outputRoot, 'functional-'))
  const result = {
    sourceHead: options.sourceHead,
    executableSha256: options.executableSha256,
    asarSha256: options.asarSha256,
    bootstrapSha256: options.bootstrapSha256,
    update,
    suiteRoot,
    profiles: [],
    passed: false,
  }
  try {
    for (const input of [undefined, fixture])
      result.profiles.push(await runProfile(options, suiteRoot, input))
    result.passed = true
    return result
  } catch (error) {
    result.failure = String(error)
    throw error
  } finally {
    await writeFile(join(suiteRoot, 'suite.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(
      process.argv.length,
      3,
      'Pass one reviewed JSON plan file; GUI execution is hosted-CI-only',
    )
    requireHostedCI()
    console.log(
      JSON.stringify(await smoke(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2),
    )
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
