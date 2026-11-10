import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { URL } from 'node:url'
import {
  BASELINE,
  installSmoke,
  inventory,
  nsisArguments,
  verifyAsset,
} from './release-install-smoke.mjs'
import { sha256 } from './release-functional-support.mjs'

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const asar = packagingRequire('@electron/asar')
const fixture = resolve('apps/desktop/src/main/testing/release-profile-0312.fixture.json')
const sourceHead = 'a'.repeat(40)

async function bundle(root, version, platform) {
  const resources = join(root, platform === 'darwin' ? 'Resources' : 'resources')
  const executable = join(
    root,
    platform === 'darwin' ? 'MacOS/ari' : platform === 'win32' ? 'ari.exe' : 'ari',
  )
  await mkdir(resources, { recursive: true })
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, `synthetic executable ${version}`)
  const input = join(root, 'asar-input')
  await mkdir(input)
  await writeFile(join(input, 'package.json'), JSON.stringify({ name: '@ari/desktop', version }))
  await finished(await asar.createPackage(input, join(resources, 'app.asar')))
  await writeFile(join(resources, 'app-update.yml'), 'provider: github\nowner: j35dev\nrepo: Ari\n')
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')
  await mkdir(unpacked, { recursive: true })
  const nativeLoads = []
  for (const name of ['pty', 'koffi', 'hook']) {
    const path = join(unpacked, `${name}.node`)
    await writeFile(path, `synthetic native bytes ${name}`)
    nativeLoads.push({ path, sha256: await sha256(path) })
  }
  return { root, resources, executable, nativeLoads }
}

async function setup(platform = 'win32', mutate) {
  const root = await mkdtemp(join(tmpdir(), 'ari-install-test-'))
  const runner = join(root, 'runner')
  await mkdir(runner)
  const old = await bundle(join(root, 'old'), '0.3.12', platform)
  const candidate = await bundle(join(root, 'candidate'), '0.3.13', platform)
  const previousArtifact = join(root, BASELINE[platform].name)
  const candidateArtifact = join(root, BASELINE[platform].name.replace('0.3.12', '0.3.13'))
  await writeFile(previousArtifact, 'synthetic baseline asset')
  await writeFile(candidateArtifact, 'synthetic candidate asset')
  const baseline = {
    name: BASELINE[platform].name,
    bytes: 24,
    sha256: await sha256(previousArtifact),
  }
  const native = {
    kind: 'packaged-native-module-load',
    version: '0.3.13',
    platform,
    arch: 'x64',
    electron: '43.4.1',
    physicalBehaviorTested: false,
    archive: join(candidate.resources, 'app.asar'),
    executableSha256: await sha256(candidate.executable),
    asarSha256: await sha256(join(candidate.resources, 'app.asar')),
    modules: Object.fromEntries(
      ['@lydell/node-pty', 'koffi', 'uiohook-napi'].map((name) => [name, { loaded: true }]),
    ),
    nativeLoads: candidate.nativeLoads,
  }
  const receipt = {
    sourceHead,
    platform,
    version: '0.3.13',
    files: [
      {
        name: BASELINE[platform].name.replace('0.3.12', '0.3.13'),
        bytes: 25,
        sha256: await sha256(candidateArtifact),
      },
    ],
    // Hosted macOS launches only the runner's native slice.
    native: platform === 'darwin' ? [{ ...native, arch: 'arm64' }] : [native],
  }
  const artifactReceipt = join(root, 'candidate-artifacts.json')
  await writeFile(artifactReceipt, JSON.stringify(receipt))
  const options = {
    sourceHead,
    platform,
    previousArtifact,
    candidateArtifact,
    artifactReceipt,
    packagedExecutable: candidate.executable,
    packagedResources: candidate.resources,
    fixture,
    hostArch: 'arm64',
  }
  const env = {
    RELEASE_FUNCTIONAL_CI: '1',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: runner,
    SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
    ARI_CONTROL_TOKEN: 'must-not-propagate',
    NODE_OPTIONS: '--must-not-propagate',
  }
  const calls = []
  const run = async (executable, args, commandOptions) => {
    calls.push({ executable, args, options: commandOptions })
    assert.equal(commandOptions.windowsHide, true)
    assert.ok(commandOptions.timeout <= 120_000)
    assert.equal(commandOptions.env.ARI_CONTROL_TOKEN, undefined)
    assert.equal(commandOptions.env.NODE_OPTIONS, undefined)
    if (executable.endsWith('reg.exe')) {
      if (args.includes('/v'))
        return {
          stdout: `InstallLocation    REG_SZ    ${join(commandOptions.cwd, 'application')}\n`,
          stderr: '',
        }
      throw Object.assign(new Error('missing'), {
        code: 1,
        stderr: 'The system was unable to find the specified registry key or value.',
      })
    }
    if (executable.endsWith('tasklist.exe'))
      return {
        stdout: 'INFO: No tasks are running which match the specified criteria.',
        stderr: '',
      }
    const current = args.includes('--extract')
      ? args[1]
      : args[0] === 'attach'
        ? args.at(-1)
        : executable
    const chosen = current.includes('0.3.12') ? old : candidate
    if (executable.endsWith('hdiutil') && args[0] === 'detach') return { stdout: '', stderr: '' }
    let destination
    if (executable.endsWith('hdiutil'))
      destination = join(args[args.indexOf('-mountpoint') + 1], 'ari.app', 'Contents')
    else if (executable.endsWith('ditto')) {
      await cp(args[0], args[1], { recursive: true })
      await mutate?.({
        root: commandOptions.cwd,
        version: args[0].includes('0.3.12') ? '0.3.12' : '0.3.13',
        destination: join(args[1], 'Contents'),
        calls,
      })
      return { stdout: '', stderr: '' }
    } else if (args.includes('--extract')) destination = join(args[2], 'opt', 'Ari')
    else destination = args.at(-1).slice(3)
    await cp(chosen.root, destination, { recursive: true })
    await mutate?.({
      root: commandOptions.cwd,
      version: chosen === old ? '0.3.12' : '0.3.13',
      destination,
      calls,
    })
    return { stdout: '', stderr: '' }
  }
  return { root, runner, options, receipt, calls, dependencies: { env, platform, baseline, run } }
}

test('production baseline pins and silent NSIS argv contract are exact', async () => {
  assert.equal(
    BASELINE.win32.sha256,
    'f8f48d7c8d55f7387032ce2bc862407d8f54b437717eeca9fc0bef5301735f1b',
  )
  assert.equal(BASELINE.win32.bytes, 123180599)
  const destination = join(tmpdir(), 'ari-install-argv')
  const args = nsisArguments(destination)
  assert.deepEqual(args, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${destination}`])
  assert.ok(!args.includes('--force-run'))
  for (const path of [`${destination} with-space`, `${destination}"`, `${destination}\n`])
    assert.throws(() => nsisArguments(path))
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args],
    { windowsHide: true, timeout: 5000 },
  )
  assert.deepEqual(
    JSON.parse(stdout),
    args,
    'Node must preserve final unquoted no-space /D argument',
  )
  const templates = join(
    dirname(packagingRequire.resolve('app-builder-lib/package.json')),
    'templates',
    'nsis',
  )
  const source = await readFile(join(templates, 'installSection.nsh'), 'utf8')
  assert.match(
    source,
    /\$\{if\} \$\{isForceRun\}\s+\$\{andIf\} \$\{Silent\}\s+!insertmacro doStartApp/,
  )
  assert.match(
    await readFile(join(templates, 'assistedInstaller.nsh'), 'utf8'),
    /GetOptions.*"\/currentuser"/,
  )
})

test('hosted guard rejects before reading missing inputs or creating runner data', async () => {
  const env = await setup()
  let called = false
  await assert.rejects(
    installSmoke(
      { ...env.options, artifactReceipt: join(env.root, 'missing') },
      {
        ...env.dependencies,
        env: {},
        run: async () => {
          called = true
        },
      },
    ),
    /GitHub-hosted/,
  )
  assert.equal(called, false)
  assert.deepEqual(await readdir(env.runner), [])
  const result = await promisify(execFile)(
    process.execPath,
    ['scripts/release-install-smoke.mjs', join(env.root, 'missing')],
    {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', RELEASE_FUNCTIONAL_CI: '' },
    },
  ).catch((error) => error)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /GitHub-hosted/)
})

test('actual asset bytes and receipt provenance reject tampering before installer commands', async () => {
  const env = await setup()
  await verifyAsset(env.options.previousArtifact, env.dependencies.baseline)
  await writeFile(env.options.previousArtifact, 'tampered baseline asset!')
  await assert.rejects(
    installSmoke(env.options, env.dependencies),
    /Installer (size|hash) mismatch/,
  )
  assert.equal(env.calls.length, 0)
  assert.deepEqual(await readdir(env.runner), [])
  for (const edit of [
    { sourceHead: 'b'.repeat(40) },
    { nativeFailure: 'timeout' },
    { native: [] },
  ]) {
    await writeFile(env.options.artifactReceipt, JSON.stringify({ ...env.receipt, ...edit }))
    await assert.rejects(installSmoke(env.options, env.dependencies))
  }
  assert.equal(env.calls.length, 0)
})

for (const platform of ['win32', 'darwin', 'linux'])
  test(`${platform} install/replacement preserves frozen sibling and emits exact installed plans`, async () => {
    const env = await setup(platform)
    const result = await installSmoke(env.options, env.dependencies)
    assert.equal(result.receiptVersion, 1)
    assert.equal(result.passed, true)
    assert.equal(result.nativeBehaviorTested, false)
    assert.equal(result.updaterBehaviorTested, false)
    assert.equal(result.osInstallerBehaviorTested, platform === 'win32')
    assert.equal(result.extractionOnly, platform === 'linux')
    assert.equal(result.applicationProfileStartupTested, false)
    assert.deepEqual(
      result.sequence.map((stage) => stage.version),
      ['0.3.12', '0.3.13'],
    )
    assert.equal(result.sequence[0].executable, result.sequence[1].executable)
    assert.equal(result.fixture.beforeSha256, result.fixture.afterSha256)
    assert.equal(result.fixture.kind, 'frozen-0312-copy')
    assert.equal(result.installed.archives.length, platform === 'darwin' ? 2 : 1)
    assert.deepEqual(
      result.plans.map((plan) => plan.arch),
      [platform === 'darwin' ? 'arm64' : 'x64'],
    )
    for (const plan of result.plans) {
      assert.equal(plan.native.executable, result.installed.executable)
      assert.equal(plan.functional.resources, result.installed.resources)
      assert.equal(plan.functional.asarSha256, await sha256(plan.functional.archive))
      assert.deepEqual(
        JSON.parse(await readFile(join(result.root, `functional-plan-${plan.arch}.json`), 'utf8')),
        plan.functional,
      )
    }
    if (platform === 'win32') {
      const installs = env.calls.filter((call) => call.args[0] === '/S')
      assert.equal(installs.length, 2)
      assert.deepEqual(installs[0].args, installs[1].args)
      assert.equal(installs[0].args.at(-1), `/D=${join(result.root, 'application')}`)
      assert.match(result.installationKind, /nsis-per-user/)
    } else if (platform === 'linux') {
      assert.match(result.installationKind, /payload-extraction/)
      assert.deepEqual(
        env.calls.map((call) => call.args[0]),
        ['--extract', '--extract'],
      )
      assert.ok((await inventory(join(result.root, 'retained-0312'))).length > 0)
    } else {
      assert.match(result.installationKind, /bundle-replacement/)
      const mounts = env.calls.filter((call) => call.args[0] === 'attach')
      assert.equal(mounts.length, 2)
      for (const mount of mounts)
        assert.ok(
          mount.args.includes('-nobrowse') &&
            mount.args.includes('-noautoopen') &&
            mount.args.includes('-readonly'),
        )
      assert.equal(env.calls.filter((call) => call.args[0] === 'detach').length, 2)
    }
    const receipt = JSON.parse(await readFile(join(result.root, 'install-receipt.json'), 'utf8'))
    assert.equal(receipt.passed, true)
  })

test('linux upgrade reads the archive now at the install path', async () => {
  const env = await setup('linux')
  const input = join(env.root, 'old', 'asar-input')
  await writeFile(join(input, 'pad.json'), `${JSON.stringify({ pad: 'p'.repeat(8192) })}\n`)
  const baselineArchive = join(env.root, 'old', 'resources', 'app.asar')
  const candidateArchive = join(env.root, 'candidate', 'resources', 'app.asar')
  asar.uncache(baselineArchive)
  // The locked ASAR writer returns its stream after end(), before the bytes finish flushing.
  await finished(await asar.createPackage(input, baselineArchive))
  assert.ok((await stat(baselineArchive)).size > (await stat(candidateArchive)).size + 8000)
  const result = await installSmoke(env.options, env.dependencies)
  assert.equal(result.passed, true)
  assert.equal(result.extractionOnly, true)
  assert.equal(result.osInstallerBehaviorTested, false)
  assert.deepEqual(
    result.sequence.map((stage) => stage.version),
    ['0.3.12', '0.3.13'],
  )
})

for (const defect of ['executable', 'native', 'fixture', 'archive'])
  test(`rejects installed ${defect} corruption and retains failure without further stages`, async () => {
    const env = await setup('win32', async ({ root, version, destination }) => {
      if (version !== '0.3.13') return
      if (defect === 'archive') {
        await cp(join(env.root, 'old/resources/app.asar'), join(destination, 'resources/app.asar'))
        return
      }
      const path =
        defect === 'executable'
          ? join(destination, 'ari.exe')
          : defect === 'native'
            ? join(destination, 'resources/app.asar.unpacked/node_modules/koffi.node')
            : join(root, 'preserved-profile/profile/sessions/changed.json')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'corruption')
    })
    await assert.rejects(
      installSmoke(env.options, env.dependencies),
      /Install verification failed; retained/,
    )
    const roots = await readdir(env.runner)
    const receipt = JSON.parse(
      await readFile(join(env.runner, roots[0], 'install-receipt.json'), 'utf8'),
    )
    assert.equal(receipt.passed, false)
    assert.match(
      receipt.failure,
      /differs from tested package|changed the preserved fixture|Installed package version mismatch/,
    )
    assert.equal(env.calls.filter((call) => call.args[0] === '/S').length, 2)
  })

test('failed baseline installer never proceeds to candidate installation', async () => {
  const env = await setup('win32', async ({ version }) => {
    if (version === '0.3.12')
      throw Object.assign(new Error('injected timeout'), {
        code: 'ETIMEDOUT',
        killed: true,
        stderr: 'installer still running',
      })
  })
  await assert.rejects(installSmoke(env.options, env.dependencies), /Install verification failed/)
  assert.equal(env.calls.filter((call) => call.args[0] === '/S').length, 1)
  const root = join(env.runner, (await readdir(env.runner))[0])
  const receipt = JSON.parse(await readFile(join(root, 'install-receipt.json'), 'utf8'))
  assert.equal(receipt.passed, false)
  assert.equal(receipt.sequence.length, 0)
  assert.equal(receipt.commands.at(-1).timedOut, true)
  assert.equal(receipt.commands.at(-1).stderr, 'installer still running')
  assert.match(receipt.failure, /nsis-0\.3\.12: installer still running/)
})

test('existing Windows registration refuses before any installer execution', async () => {
  const env = await setup()
  const run = env.dependencies.run
  env.dependencies.run = async (executable, args, options) => {
    if (executable.endsWith('reg.exe'))
      return { stdout: 'InstallLocation REG_SZ C:/existing', stderr: '' }
    return run(executable, args, options)
  }
  await assert.rejects(installSmoke(env.options, env.dependencies), /Install verification failed/)
  assert.equal(env.calls.filter((call) => call.args[0] === '/S').length, 0)
  const root = join(env.runner, (await readdir(env.runner))[0])
  assert.equal(JSON.parse(await readFile(join(root, 'install-receipt.json'), 'utf8')).passed, false)
})

test('wrong registered installation identity refuses upgrade after baseline', async () => {
  const env = await setup()
  const run = env.dependencies.run
  env.dependencies.run = async (executable, args, options) => {
    if (executable.endsWith('reg.exe') && args.includes('/v'))
      return { stdout: `InstallLocation REG_SZ ${env.root}\n`, stderr: '' }
    return run(executable, args, options)
  }
  await assert.rejects(installSmoke(env.options, env.dependencies), /Install verification failed/)
  assert.equal(env.calls.filter((call) => call.args[0] === '/S').length, 1)
  const root = join(env.runner, (await readdir(env.runner))[0])
  assert.match(
    JSON.parse(await readFile(join(root, 'install-receipt.json'), 'utf8')).failure,
    /different installation folder/,
  )
})

test('DMG copy failure detaches the owned mount and never proceeds to candidate', async () => {
  const env = await setup('darwin')
  const run = env.dependencies.run
  env.dependencies.run = async (executable, args, options) => {
    if (executable.endsWith('ditto')) throw new Error('injected copy failure')
    return run(executable, args, options)
  }
  await assert.rejects(installSmoke(env.options, env.dependencies), /Install verification failed/)
  assert.equal(env.calls.filter((call) => call.args[0] === 'attach').length, 1)
  assert.equal(env.calls.filter((call) => call.args[0] === 'detach').length, 1)
})
