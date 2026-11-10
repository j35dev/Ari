import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import afterPack, { expectedPtyPackages } from '../apps/desktop/packaging/after-pack.js'
import {
  archivePath,
  isolatedEnvironment,
  executionCommand,
  sha256,
  smoke,
} from './release-native-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
async function fixture(arch = 1, platform = process.platform === 'linux' ? 'win32' : 'linux') {
  const dir = await mkdtemp(join(tmpdir(), 'ari-native-guard-'))
  const resources =
    platform === 'darwin' ? join(dir, 'Ari.app/Contents/Resources') : join(dir, 'resources')
  const context = {
    appOutDir: dir,
    electronPlatformName: platform,
    arch,
    packager: { appInfo: { productFilename: 'Ari' } },
  }
  async function file(path, value = 'fixture, not a binary') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value)
  }
  return { dir, resources, context, file }
}
async function ancillary(f) {
  for (const path of ['agent-cli/ari.cjs', 'agent-cli/ari/SKILL.md', 'mobile/index.html'])
    await f.file(join(f.resources, path))
}
async function pty(f, omitted) {
  const unpacked = join(f.resources, 'app.asar.unpacked/node_modules')
  await mkdir(join(unpacked, '@lydell/node-pty'), { recursive: true })
  for (const name of expectedPtyPackages(f.context.electronPlatformName, f.context.arch))
    if (name !== omitted) await f.file(join(unpacked, name, 'prebuilds/any.node'))
}

test('the actual afterPack rejects missing agent resources', async () => {
  const f = await fixture()
  await assert.rejects(afterPack(f.context), /Agent CLI or bundled Ari skill is missing/)
})
test('the actual afterPack rejects a missing mobile shell', async () => {
  const f = await fixture()
  await f.file(join(f.resources, 'agent-cli/ari.cjs'))
  await f.file(join(f.resources, 'agent-cli/ari/SKILL.md'))
  await assert.rejects(afterPack(f.context), /Mobile PWA is missing/)
})
test('the actual afterPack rejects a missing PTY resolver', async () => {
  const f = await fixture()
  await ancillary(f)
  await assert.rejects(afterPack(f.context), /resolver stub.*not unpacked/)
})
test('the actual afterPack rejects the missing target addon', async () => {
  const f = await fixture()
  await ancillary(f)
  const name = expectedPtyPackages(f.context.electronPlatformName, f.context.arch)[0]
  await pty(f, name)
  await mkdir(join(f.resources, 'app.asar.unpacked/node_modules', name, 'prebuilds'), {
    recursive: true,
  })
  await assert.rejects(afterPack(f.context), /has no unpacked .node addon/)
})
test('the actual universal guard rejects a missing second PTY slice', async () => {
  const f = await fixture(4, 'darwin')
  await ancillary(f)
  await pty(f, '@lydell/node-pty-darwin-arm64')
  await assert.rejects(afterPack(f.context), /darwin-arm64 is missing/)
})
test('presence-only guard accepts dummy PTY addons without hook, Koffi or PTY helpers', async () => {
  const f = await fixture()
  await ancillary(f)
  await pty(f)
  await afterPack(f.context)
  assert.equal(existsSync(join(f.resources, 'app.asar')), false)
  // Deliberately synthetic files: this result proves the guard's limit, not native behavior.
})
test('archive selection covers standard and split universal packages', async () => {
  const f = await fixture()
  assert.equal(archivePath(f.resources, 'arm64'), join(f.resources, 'app.asar'))
  await f.file(join(f.resources, 'app-arm64.asar'))
  assert.equal(archivePath(f.resources, 'arm64'), join(f.resources, 'app-arm64.asar'))
})
test('launch environment excludes credentials, dictation flags and Node startup overrides', () => {
  const env = isolatedEnvironment('/isolated', {
    PATH: 'fixture-path',
    SystemRoot: 'fixture-system',
    DISPLAY: ':99',
    XAUTHORITY: '/isolated/xauth',
    NODE_OPTIONS: '--require unsafe',
    ARIA_DICTATION_VISIBLE_FIXTURE: '1',
    ARIA_DICTATION_NATIVE_ONLY: '1',
    ARI_CONTROL_TOKEN: 'synthetic-test-only',
  })
  assert.equal(env.PATH, 'fixture-path')
  assert.equal(env.DISPLAY, ':99')
  assert.equal(env.XAUTHORITY, '/isolated/xauth')
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  for (const key of [
    'NODE_OPTIONS',
    'ARI_CONTROL_TOKEN',
    'ARIA_DICTATION_VISIBLE_FIXTURE',
    'ARIA_DICTATION_NATIVE_ONLY',
  ])
    assert.equal(env[key], undefined)
})
test('macOS probes explicitly select the other universal slice', () => {
  assert.deepEqual(executionCommand('/Ari', ['probe'], 'x64', 'darwin', 'arm64'), {
    executable: '/usr/bin/arch',
    args: ['-x86_64', '/Ari', 'probe'],
  })
  assert.deepEqual(executionCommand('/Ari', ['probe'], 'arm64', 'darwin', 'arm64'), {
    executable: '/Ari',
    args: ['probe'],
  })
})
test('receipt mismatches reject before invoking any executable', async () => {
  const f = await fixture()
  const executable = join(f.dir, 'fixture.exe')
  await f.file(executable)
  await f.file(join(f.resources, 'app.asar'))
  let invoked = false
  await assert.rejects(
    smoke(
      {
        executable,
        resources: f.resources,
        arch: 'x64',
        executableSha256: '0'.repeat(64),
        asarSha256: '0'.repeat(64),
        dataRoot: join(f.dir, 'data'),
      },
      async () => {
        invoked = true
      },
    ),
    /Executable receipt mismatch/,
  )
  assert.equal(invoked, false)
})
test('launcher keeps calls hidden, bounded and isolated; no native execution in this fixture', async () => {
  const f = await fixture()
  const executable = join(f.dir, 'fixture.exe')
  const archive = join(f.resources, 'app.asar')
  await f.file(executable)
  await f.file(archive)
  const options = {
    executable,
    resources: f.resources,
    arch: 'x64',
    executableSha256: await sha256(executable),
    asarSha256: await sha256(archive),
    dataRoot: join(f.dir, 'data'),
  }
  const result = await smoke(options, async (file, args, opts) => {
    const expected = executionCommand(
      executable,
      [join(here, 'release-native-probe.mjs'), archive, 'x64'],
      'x64',
    )
    assert.equal(file, expected.executable)
    assert.deepEqual(args, expected.args)
    assert.equal(opts.windowsHide, true)
    assert.equal(opts.timeout, 15_000)
    assert.equal(opts.cwd, opts.env.HOME)
    assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1')
    return {
      stdout: JSON.stringify({
        kind: 'packaged-native-module-load',
        arch: 'x64',
        archive,
        electron: 'fixture-only',
        physicalBehaviorTested: false,
      }),
      stderr: '',
    }
  })
  assert.ok(result.isolatedData.startsWith(options.dataRoot))
})
test('probe rejects ordinary Node before resolving any native dependency', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [join(here, 'release-native-probe.mjs')], {
      windowsHide: true,
      timeout: 5_000,
      env: isolatedEnvironment(tmpdir()),
    }),
    (error) => /requires the reviewed packaged Electron binary/.test(error.stderr),
  )
})

test('failed child receipts preserve timeout and signal evidence without native execution', async () => {
  const f = await fixture()
  const executable = join(f.dir, 'fixture.exe')
  const archive = join(f.resources, 'app.asar')
  await f.file(executable)
  await f.file(archive)
  const failure = Object.assign(new Error('Command failed'), {
    code: null,
    signal: 'SIGTERM',
    killed: true,
    stdout: 'partial probe receipt',
    stderr: '',
  })
  await assert.rejects(
    smoke(
      {
        executable,
        resources: f.resources,
        arch: 'x64',
        executableSha256: await sha256(executable),
        asarSha256: await sha256(archive),
        dataRoot: join(f.dir, 'data'),
      },
      async () => {
        throw failure
      },
    ),
    (error) => {
      const receipt = JSON.parse(error.message)
      assert.equal(receipt.arch, 'x64')
      assert.equal(receipt.timeoutMs, 15_000)
      assert.equal(receipt.signal, 'SIGTERM')
      assert.equal(receipt.killed, true)
      assert.equal(receipt.stdout, 'partial probe receipt')
      assert.equal(error.cause, failure)
      return true
    },
  )
})
