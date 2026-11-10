// Node-only safety/protocol/real frozen disk-fixture tests. Never runs Electron.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  CDP,
  FIXTURE_SHA256,
  PROVIDERS,
  isolatedEnvironment,
  prepareProfile,
  requireHostedCI,
  relocate,
  sha256,
  updaterConfig,
  startupScriptKind,
  pauseBeforeArchivedApp,
  poll,
  normalizeScriptURL,
} from './release-functional-support.mjs'
import { assertCleanExit, launchCommand, smoke } from './release-functional-smoke.mjs'

const fixturePath = process.env.RELEASE_FUNCTIONAL_FIXTURE
const testRoot =
  process.env.RELEASE_FUNCTIONAL_TEST_ROOT ?? join(tmpdir(), 'ari-functional-node-tests')
async function fresh() {
  await mkdir(testRoot, { recursive: true })
  return realpath(await mkdtemp(join(testRoot, 'retained-')))
}

test('local execution is rejected before even invalid artifact paths are inspected', async () => {
  assert.throws(() => requireHostedCI({ CI: 'true', RELEASE_FUNCTIONAL_CI: '1' }), /GitHub-hosted/)
  for (const key of [
    'RELEASE_FUNCTIONAL_CI',
    'CI',
    'GITHUB_ACTIONS',
    'RUNNER_ENVIRONMENT',
    'RUNNER_TEMP',
  ]) {
    const env = {
      RELEASE_FUNCTIONAL_CI: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TEMP: testRoot,
    }
    delete env[key]
    assert.throws(() => requireHostedCI(env), /GitHub-hosted/)
  }
  // Test the actual public launch boundary, without setting its CI opt-in.
  if (process.env.RELEASE_FUNCTIONAL_CI !== '1') await assert.rejects(smoke({}), /GitHub-hosted/)
})

test('environment allowlist removes live credentials, loader and visible/native fixture flags', () => {
  const env = isolatedEnvironment(testRoot, {
    ARI_CONTROL_TOKEN: 'synthetic-do-not-forward',
    ARI_CONTROL_URL: 'http://synthetic',
    NODE_OPTIONS: '--require synthetic',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_RENDERER_URL: 'http://synthetic',
    ARIA_DICTATION_VISIBLE_FIXTURE: '1',
    ARIA_DICTATION_NATIVE_ONLY: '1',
    CODEX_HOME: 'synthetic',
    CLAUDE_CONFIG_DIR: 'synthetic',
    OPENAI_API_KEY: 'synthetic',
    PATH: 'synthetic/provider/bin',
    SystemRoot: 'C:/Windows',
    DISPLAY: ':99',
    XAUTHORITY: '/tmp/test-only-auth',
  })
  for (const key of [
    'ARI_CONTROL_TOKEN',
    'ARI_CONTROL_URL',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'ARIA_DICTATION_VISIBLE_FIXTURE',
    'ARIA_DICTATION_NATIVE_ONLY',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'OPENAI_API_KEY',
  ])
    assert.ok(!(key in env), key)
  assert.ok(!env.PATH.includes('synthetic'))
  assert.equal(env.DISPLAY, ':99')
  assert.equal(env.XAUTHORITY, '/tmp/test-only-auth')
  assert.equal(env.ARI_NO_LOGIN_SHELL, '1')
  assert.equal(env.HOME, join(testRoot, 'home'))
})

test('clean profile has no saved work, disabled background services, and no schedule', async () => {
  const root = await fresh()
  const result = await prepareProfile(root)
  const settings = JSON.parse(await readFile(join(result.profile, 'settings.json'), 'utf8'))
  for (const kind of PROVIDERS)
    assert.deepEqual(settings.providers[kind], {
      enabled: false,
      binaryPath: '',
      accounts: [],
      activeAccount: 'default',
    })
  assert.ok(
    !settings.speech.enabled &&
      !settings.speech.duckAudio &&
      !settings.remote.enabled &&
      !settings.delegation.enabled,
  )
  assert.equal(settings.onboarding, undefined)
  assert.equal(settings.sourceControl.fetchIntervalSeconds, 0)
  assert.deepEqual(
    JSON.parse(await readFile(join(result.profile, 'resume-schedule.json'), 'utf8')),
    [],
  )
  await assert.rejects(prepareProfile(root), /fresh empty/)
})

test('cross-platform relocation changes path-token values, preserves text, and rejects traversal', () => {
  const source = {
    path: '{{PROFILE_ROOT}}\\\\workspaces\\\\open',
    text: 'Do not change C:\\synthetic or {{PROFILE_ROOT}} here',
    items: ['{{PROFILE_ROOT}}/profile/aria'],
  }
  assert.deepEqual(relocate(source, testRoot), {
    path: join(testRoot, 'workspaces', 'open'),
    text: source.text,
    items: [join(testRoot, 'profile', 'aria')],
  })
  assert.throws(() => relocate('{{PROFILE_ROOT}}/../outside', testRoot), /Unsafe/)
  assert.throws(() => relocate('{{PROFILE_ROOT}}/C:/outside', testRoot), /Unsafe/)
})

test(
  'real frozen 0.3.12 disk copy retains transcript/queues/images/defaults and immutable input',
  { skip: !fixturePath && 'Set RELEASE_FUNCTIONAL_FIXTURE to the reviewed frozen fixture' },
  async () => {
    const before = await readFile(fixturePath)
    assert.equal(await sha256(fixturePath), FIXTURE_SHA256)
    const root = await fresh()
    const { profile, fixture, receipt } = await prepareProfile(root, fixturePath)
    assert.deepEqual(receipt.relocated, ['profile/projects.json', 'profile/settings.json'])
    for (const file of fixture.files.filter((file) => /sessions\/|attachments\//.test(file.path)))
      assert.deepEqual(
        await readFile(join(root, file.path)),
        file.base64 ? Buffer.from(file.base64, 'base64') : Buffer.from(file.utf8),
        file.path,
      )
    const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))
    assert.equal(settings.appearance.themeId, 'graphite')
    assert.equal(settings.appearance.fontSize, 15)
    assert.equal(settings.sessions.defaultPermissionMode, 'ask')
    assert.equal(settings.speech.modelPath, join(root, 'models', 'tiny.gguf'))
    const projects = JSON.parse(await readFile(join(profile, 'projects.json'), 'utf8'))
    const project = projects.projects.find((item) => item.id === fixture.expected.projectId)
    assert.deepEqual(project.defaultAgent, fixture.expected.agent)
    assert.equal(project.path, join(root, 'workspaces', 'open'))
    assert.equal(projects.removed[0].project.id, fixture.expected.removedId)
    assert.equal(fixture.rendererStorage['ari.drafts'].includes('Unsent synthetic draft'), true)
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'resume-schedule.json'), 'utf8')), [])
    assert.deepEqual(await readFile(fixturePath), before)
  },
)

test('updater target is read explicitly; wrong, duplicate and unsupported scalars fail', () => {
  assert.deepEqual(
    updaterConfig('provider: github\nowner: j35dev\nrepo: Ari\nupdaterCacheDirName: ari-updater\n'),
    { provider: 'github', owner: 'j35dev', repo: 'Ari' },
  )
  assert.deepEqual(updaterConfig('provider: "github"\nowner: \'j35dev\'\nrepo: Ari\n'), {
    provider: 'github',
    owner: 'j35dev',
    repo: 'Ari',
  })
  for (const text of [
    'provider: github\nowner: other\nrepo: Ari',
    'provider: github\nprovider: github\nowner: j35dev\nrepo: Ari',
    'provider: |\nowner: j35dev\nrepo: Ari',
  ])
    assert.throws(() => updaterConfig(text))
})

test('universal x64 execution uses a real arch command and retains debugger isolation flags', () => {
  const command = launchCommand('/synthetic/ari', 'x64', 1111, 2222, 'darwin', 'arm64')
  assert.equal(command.file, '/usr/bin/arch')
  assert.deepEqual(command.args.slice(0, 2), ['-x86_64', '/synthetic/ari'])
  assert.ok(command.args.includes('--inspect-brk=127.0.0.1:1111'))
  assert.ok(command.args.includes('--remote-debugging-address=127.0.0.1'))
  assert.equal(
    launchCommand('/synthetic/ari', 'arm64', 1111, 2222, 'darwin', 'arm64').file,
    '/synthetic/ari',
  )
})

test('shutdown failure cannot pass as exit zero, and code/signal/timeout remain actionable', () => {
  const exit = { code: 0, signal: null, forced: false, timedOut: false }
  const stdout = JSON.stringify({
    kind: 'release-functional-shutdown',
    willQuit: true,
    ready: true,
    errors: [],
  })
  assert.equal(assertCleanExit(exit, stdout, '').willQuit, true)
  for (const edit of [{ code: 1 }, { signal: 'SIGTERM' }, { forced: true }, { timedOut: true }])
    assert.throws(() => assertCleanExit({ ...exit, ...edit }, stdout, ''))
  assert.throws(() => assertCleanExit(exit, '', ''), /will-quit/)
  assert.throws(() => assertCleanExit(exit, stdout, 'shutdown deadline reached'))
  assert.throws(() =>
    assertCleanExit(exit, stdout.replace('"errors":[]', '"errors":["preload failed"]'), ''),
  )
})

test('CDP rejects dropped connections and bounded command timeouts; remote transports are refused', async () => {
  class Socket extends EventEmitter {
    addEventListener(event, callback) {
      this.on(event, callback)
    }
    send() {}
    close() {
      this.emit('close')
    }
  }
  const socket = new Socket()
  const client = new CDP(socket)
  await assert.rejects(client.send('test.timeout', {}, 5), /CDP timed out/)
  const pending = client.send('test.disconnect')
  socket.close()
  await assert.rejects(pending, /disconnected/)
  await assert.rejects(CDP.connect('ws://example.invalid/unsafe'), /loopback/)
})

test('bootstrap classification admits only framework and selected archive code', () => {
  assert.equal(
    startupScriptKind('node:electron/js2c/browser_init', '/test/app-arm64.asar', '/test'),
    'framework',
  )
  assert.equal(
    startupScriptKind('electron/js2c/browser_init', '/test/app-arm64.asar', '/test'),
    'framework',
  )
  assert.equal(
    startupScriptKind('file:///test/app.asar/index.js', '/test/app-arm64.asar', '/test'),
    'app',
  )
  assert.equal(
    startupScriptKind(
      'file:///test/app-arm64.asar/out/main/index.js',
      '/test/app-arm64.asar',
      '/test',
    ),
    'app',
  )
  assert.equal(
    startupScriptKind('file:///test/other.asar/index.js', '/test/app-arm64.asar', '/test'),
    'unknown',
  )
  assert.equal(startupScriptKind('/outside/helper.js', '/test/app-arm64.asar', '/test'), 'unknown')
  assert.equal(
    startupScriptKind('file:///D:/test/app.asar/out/main/index.js', 'D:/test/app.asar', 'D:/test'),
    'app',
  )
})

// Feed real CDP request/reply/event parsing with a deterministic bootstrap,
// without Electron. The existing real Node CJS/ESM cases cover execution safety.
async function bootstrapProtocol(framework, pauseDelayMs = 0) {
  const root = await fresh()
  const archive = join(root, 'synthetic.asar')
  await mkdir(archive)
  const app = { scriptId: 'app', url: pathToFileURL(join(archive, 'out/main/index.js')).href }
  class Socket extends EventEmitter {
    position = -1
    appResumed = false
    commands = []
    addEventListener(event, callback) {
      this.on(event, callback)
    }
    send(bytes) {
      const request = JSON.parse(bytes)
      this.commands.push(request.method)
      const current = framework[this.position]
      if (request.method === 'Debugger.resume' && current === app) this.appResumed = true
      if (['Runtime.runIfWaitingForDebugger', 'Debugger.resume'].includes(request.method)) {
        const frame = framework[++this.position]
        if (frame) {
          const emitPause = () => {
            this.emit('message', {
              data: JSON.stringify({ method: 'Debugger.scriptParsed', params: frame }),
            })
            this.emit('message', {
              data: JSON.stringify({
                method: 'Debugger.paused',
                params: {
                  reason: 'instrumentation',
                  callFrames: [
                    { location: { scriptId: frame.scriptId, lineNumber: 0, columnNumber: 0 } },
                  ],
                },
              }),
            })
          }
          if (pauseDelayMs) this.pauseTimer = setTimeout(emitPause, pauseDelayMs)
          else emitPause()
        }
      }
      this.emit('message', {
        data: JSON.stringify({ id: request.id, result: { breakpointId: 'before-script' } }),
      })
    }
    close() {
      clearTimeout(this.pauseTimer)
      this.emit('close')
    }
  }
  const socket = new Socket()
  return { root, archive, app, frames: framework, socket, client: new CDP(socket) }
}

const frameworkModules = (count = 150) =>
  Array.from({ length: count }, (_, index) => ({
    scriptId: String(index),
    url: `node:internal/bootstrap-regression/module-${index}`,
  }))

test('CDP bootstrap allows >100 distinct framework modules and leaves the app paused', async () => {
  const fixture = await bootstrapProtocol(frameworkModules())
  fixture.frames.push(fixture.app)
  try {
    const { trace } = await pauseBeforeArchivedApp(fixture.client, fixture.archive, fixture.root)
    assert.equal(trace.length, 151)
    assert.ok(trace.slice(0, -1).every((entry) => entry.kind === 'framework'))
    assert.equal(trace.at(-1).kind, 'app')
    assert.equal(fixture.socket.appResumed, false)
    assert.equal(fixture.socket.commands.at(-1), 'Debugger.removeBreakpoint')
  } finally {
    fixture.client.close()
  }
})

test('CDP bootstrap refuses a repeated pause without resuming it', async () => {
  const repeated = { scriptId: 'same', url: 'node:internal/bootstrap-regression/repeated' }
  const fixture = await bootstrapProtocol([repeated, repeated])
  fixture.frames.push(fixture.app)
  try {
    await assert.rejects(
      pauseBeforeArchivedApp(fixture.client, fixture.archive, fixture.root),
      /no progress/i,
    )
    assert.equal(fixture.socket.commands.filter((method) => method === 'Debugger.resume').length, 1)
    assert.equal(fixture.socket.appResumed, false)
  } finally {
    fixture.client.close()
  }
})

test('CDP bootstrap still refuses unknown filesystem and eval code', async () => {
  for (const url of ['file:///outside/bootstrap.js', 'evalmachine.<anonymous>']) {
    const fixture = await bootstrapProtocol([{ scriptId: 'unknown', url }])
    try {
      await assert.rejects(
        pauseBeforeArchivedApp(fixture.client, fixture.archive, fixture.root),
        /Unknown code/,
      )
      assert.ok(!fixture.socket.commands.includes('Debugger.resume'))
    } finally {
      fixture.client.close()
    }
  }
})

test(
  'CDP bootstrap has one finite budget despite continued module progress',
  { timeout: 25_000 },
  async () => {
    const fixture = await bootstrapProtocol(frameworkModules(1000), 30)
    try {
      await assert.rejects(
        pauseBeforeArchivedApp(fixture.client, fixture.archive, fixture.root),
        /bootstrap time budget/i,
      )
      assert.ok(fixture.socket.position > 100 && fixture.socket.position < 1000)
      assert.equal(fixture.socket.appResumed, false)
    } finally {
      fixture.client.close()
    }
  },
)

for (const mode of ['cjs', 'esm', 'unknown', 'cjs-alias', 'esm-alias'])
  test(
    `real Node inspector ${mode}: shared pre-execution guard protects dependency side effects (not Electron proof)`,
    { timeout: 10_000 },
    async () => {
      const container = await fresh()
      const aliased = mode.endsWith('-alias')
      let root = container
      if (aliased) {
        const physical = join(container, 'physical')
        await mkdir(physical)
        root = join(container, 'alias')
        // A retained alias of this test's own new directory, never a dependency
        // or existing worktree link. Windows directory aliases use junctions.
        await symlink(physical, root, process.platform === 'win32' ? 'junction' : 'dir')
      }
      // Ordinary synthetic directories, not actual ASAR/Electron packages.
      const archive = join(root, 'synthetic.asar')
      await mkdir(archive)
      const sentinel = join(root, 'executed.json')
      const esm = mode.startsWith('esm')
      const extension = esm ? 'mjs' : 'cjs'
      const entry = join(mode === 'unknown' ? root : archive, `main.${extension}`)
      const dependency = join(archive, `dependency.${extension}`)
      const writer = `writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify({ value: process.env.RELEASE_FUNCTIONAL_NODE_PROOF }))`
      await writeFile(
        dependency,
        esm
          ? `import { writeFileSync } from 'node:fs'; ${writer}`
          : `const { writeFileSync } = require('node:fs'); ${writer}`,
      )
      await writeFile(
        entry,
        esm
          ? "import './dependency.mjs'"
          : mode === 'unknown'
            ? `require(${JSON.stringify(dependency)})`
            : "require('./dependency.cjs')",
      )
      const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', entry], {
        cwd: root,
        env: isolatedEnvironment(root),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let client
      let nodeStderr = ''
      const closed = new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
      )
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 8000)
      try {
        const url = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.stderr.on('data', (bytes) => {
            nodeStderr += bytes
            const match = nodeStderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)
            if (match) resolve(match[0])
          })
        })
        client = await CDP.connect(url)
        const trace = []
        if (mode === 'unknown') {
          await assert.rejects(pauseBeforeArchivedApp(client, archive, root, trace), /Unknown code/)
          await assert.rejects(readFile(sentinel), { code: 'ENOENT' })
          child.kill('SIGKILL')
          await closed
          client.close()
          return
        }
        try {
          await pauseBeforeArchivedApp(client, archive, root, trace)
        } catch (error) {
          await writeFile(join(root, 'guard-failure.json'), JSON.stringify(trace, null, 2))
          throw error
        }
        assert.equal(trace.at(-1).kind, 'app')
        assert.ok(['instrumentation', 'Break on start'].includes(trace.at(-1).reason))
        if (aliased) {
          assert.notEqual(root, await realpath(root), 'Regression must use a real directory alias')
          assert.ok(
            normalizeScriptURL(trace.at(-1).url).startsWith(
              `${normalizeScriptURL(await realpath(archive))}/`,
            ),
          )
        }
        await assert.rejects(readFile(sentinel), { code: 'ENOENT' })
        assert.equal(
          await client.evaluate(
            "process.env.RELEASE_FUNCTIONAL_NODE_PROOF = 'injected-before-user-code'",
            1000,
            false,
          ),
          'injected-before-user-code',
        )
        await client.send('Debugger.resume')
        await poll(
          'Node waiting for debugger disconnect',
          () => /Waiting for (?:the )?debugger to disconnect/.test(nodeStderr),
          3000,
        )
        client.close()
        const exit = await closed
        assert.deepEqual(exit, { code: 0, signal: null })
        assert.deepEqual(JSON.parse(await readFile(sentinel, 'utf8')), {
          value: 'injected-before-user-code',
        })
      } finally {
        child.kill()
        client?.close()
        clearTimeout(watchdog)
        await writeFile(join(root, 'node-stderr.log'), nodeStderr)
      }
    },
  )
