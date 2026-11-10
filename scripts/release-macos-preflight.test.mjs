import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { setImmediate } from 'node:timers'
import { cachedStockRuntime, preflight } from './release-macos-preflight.mjs'

test('stock diagnostic requires cached exact bytes and never downloads or rewrites cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-stock-cache-test-'))
  const physical = join(root, 'physical-cache')
  await mkdir(join(physical, 'entry'), { recursive: true })
  const cache = join(root, 'cache-alias')
  await symlink(physical, cache, process.platform === 'win32' ? 'junction' : 'dir')
  const bytes = Buffer.from('synthetic ZIP; never native')
  const expected = {
    name: 'electron-test.zip',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const path = join(cache, 'entry', expected.name)
  await writeFile(path, bytes)
  const canonicalPath = await realpath(path)
  let calls = 0
  const run = async (file, args, options) => {
    calls++
    assert.equal(file, '/usr/bin/ditto')
    assert.deepEqual(args.slice(0, 3), ['-x', '-k', canonicalPath])
    assert.equal(options.timeout, 30_000)
    assert.equal(options.windowsHide, true)
    await mkdir(join(args[3], 'Electron.app/Contents/MacOS'), { recursive: true })
    await writeFile(join(args[3], 'Electron.app/Contents/MacOS/Electron'), 'synthetic executable')
  }
  const result = await cachedStockRuntime(cache, root, run, expected)
  assert.equal(result.zipSha256, expected.sha256)
  assert.equal(calls, 1)
  await writeFile(path, Buffer.alloc(bytes.length))
  await assert.rejects(cachedStockRuntime(cache, root, run, expected), /Pinned stock/)
  assert.equal(calls, 1)
})

test('stock comparison cannot make a failed universal gate pass and keeps the same budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-stock-compare-test-'))
  const executable = join(root, 'synthetic')
  await writeFile(executable, 'synthetic executable')
  const stock = { executable: '/synthetic/stock/Electron' }
  const result = await preflight(
    executable,
    root,
    async (_file, args, options) => {
      assert.equal(options.timeout, 15_000)
      if (args.includes(executable))
        throw Object.assign(new Error('universal loader timeout'), { killed: true })
      return { stdout: 'synthetic observation', stderr: '' }
    },
    stock,
  )
  assert.equal(result.commands[2].required, true)
  assert.equal(result.commands[2].success, false)
  assert.equal(result.commands[3].required, false)
  assert.equal(result.commands[3].success, true)
  assert.equal(
    result.commands.every((entry) => !entry.required || entry.success),
    false,
  )
})

test('translation diagnostics preserve separate system and packaged startup failures without native execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-macos-diagnostics-'))
  const executable = join(root, 'not-an-executable')
  await writeFile(executable, 'fixture only')
  let calls = 0
  const result = await preflight(executable, root, async (file, args, options) => {
    calls++
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 15_000)
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(options.env.ARI_CONTROL_TOKEN, undefined)
    if (file.endsWith('pkgutil')) throw Object.assign(new Error('No package receipt'), { code: 1 })
    if (args.includes('/usr/bin/uname')) return { stdout: 'x86_64\n', stderr: '' }
    throw Object.assign(new Error('Timeout before JavaScript'), {
      code: null,
      signal: 'SIGTERM',
      killed: true,
      stdout: '',
      stderr: '',
    })
  })
  assert.equal(calls, 3)
  assert.equal(result.commands[0].required, false)
  assert.equal(result.commands[1].success, true)
  assert.equal(result.commands[2].success, false)
  assert.equal(result.commands[2].signal, 'SIGTERM')
  assert.equal(result.commands[2].killed, true)
})

test('ordinary local invocation rejects before selecting a packaged executable', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, ['scripts/release-macos-preflight.mjs'], {
      env: { ...process.env, CI: '' },
      windowsHide: true,
      timeout: 5000,
    }),
    (error) => /CI-only/.test(error.stderr),
  )
})

test('samples only the exact owned stalled child within the unchanged startup deadline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ari-macos-owned-sample-'))
  const executable = join(root, 'not-an-executable')
  await writeFile(executable, 'fixture only')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let rejectStartup
  const samples = []
  const execution = preflight(executable, root, (file, args, options) => {
    if (file.endsWith('sample')) {
      samples.push({ file, args, options })
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    if (args.includes('-e')) {
      assert.ok(args.at(-1).startsWith("require('node:fs').writeSync(2,'entered-eval"))
      assert.equal(options.timeout, 15_000)
      return Object.assign(
        new Promise((_resolve, reject) => {
          rejectStartup = reject
        }),
        { child: { pid: 123456, exitCode: null, signalCode: null } },
      )
    }
    return Promise.resolve({ stdout: 'fixture', stderr: '' })
  })
  while (!rejectStartup) await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(4999)
  assert.equal(samples.length, 0)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(samples.length, 1)
  assert.equal(samples[0].args[0], '123456')
  assert.equal(samples[0].options.windowsHide, true)
  assert.equal(samples[0].options.timeout, 3000)
  rejectStartup(Object.assign(new Error('startup timeout'), { signal: 'SIGTERM', killed: true }))
  const result = await execution
  assert.equal(result.commands.at(-1).success, false)
  assert.equal(result.sample.success, true)
  assert.equal(result.sample.pid, result.ownedChildPid)
  t.mock.timers.reset()
})
