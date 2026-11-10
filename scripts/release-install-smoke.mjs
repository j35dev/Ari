// Hosted-CI-only package installation. Importing this module never runs an installer.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { promisify } from 'node:util'
import { archivePath } from './release-native-smoke.mjs'
import { BASELINE } from './release-install-baseline.mjs'
export { BASELINE } from './release-install-baseline.mjs'
import {
  contained,
  isolatedEnvironment,
  prepareProfile,
  requireHostedCI,
  sha256,
} from './release-functional-support.mjs'

const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const asar = packagingRequire('@electron/asar') // Existing packaging dependency; pure filesystem IO.

const GUID = 'fd055408-59d9-59bf-b984-065eaf3c68a4' // Builder UUID v5(com.ari.desktop).
const candidateName = (platform) => BASELINE[platform].name.replace('0.3.12', '0.3.13')
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const commandText = (value) => {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  return text.slice(0, 2048)
}

export function nsisArguments(destination) {
  // NSIS /D is last and unquoted. Do not rely on Node's quoting of paths with spaces.
  assert.ok(
    isAbsolute(destination) &&
      !/[\s"]/.test(destination) &&
      ![...destination].some((character) => character.charCodeAt(0) < 32),
    'NSIS requires a confined no-space destination',
  )
  // Locked 26.15.3 installSection.nsh starts a silent assisted install only with
  // --force-run. /currentuser also overrides detected per-machine installation.
  return ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${destination}`]
}

export async function verifyAsset(path, expected) {
  assert.equal(basename(path), expected.name, 'Unexpected installer filename')
  assert.match(expected.sha256 ?? '', /^[a-f0-9]{64}$/)
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Installer must be a regular file')
  assert.equal(info.size, expected.bytes, 'Installer size mismatch')
  assert.equal(await sha256(path), expected.sha256, 'Installer hash mismatch')
  return { ...expected, path, version: expected.name.includes('0.3.12') ? '0.3.12' : '0.3.13' }
}

export async function inventory(root, selected) {
  const entries = []
  async function walk(path) {
    assert.ok(contained(root, path), 'Inventory escaped root')
    const info = await lstat(path)
    assert.ok(!info.isSymbolicLink(), 'Inventory contains a symlink')
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name))
    } else {
      assert.ok(info.isFile() && entries.length < 5000, 'Unbounded or unsupported inventory')
      entries.push({
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: info.size,
        sha256: await sha256(path),
      })
    }
  }
  for (const name of selected ?? (await readdir(root)).sort()) await walk(join(root, name))
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

async function installation(executable, resources, platform, version) {
  const info = await lstat(executable)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Installed executable is not a regular file')
  const names = (await readdir(resources))
    .filter(
      (name) =>
        /^app(?:-(?:arm64|x64))?\.asar(?:\.unpacked)?$/.test(name) || name === 'app-update.yml',
    )
    .sort()
  assert.ok(
    names.includes('app.asar') && names.includes('app-update.yml'),
    'Missing installed bootstrap/updater resources',
  )
  const arches = platform === 'darwin' ? ['arm64', 'x64'] : ['x64']
  const archives = []
  for (const arch of arches) {
    const archive = archivePath(resources, arch)
    // @electron/asar caches header offsets by path. The upgrade extract replaces that path.
    asar.uncache(archive)
    const bytes = asar.extractFile(archive, 'package.json')
    assert.ok(bytes.length < 128 * 1024, 'Unbounded archived package manifest')
    assert.equal(JSON.parse(bytes).version, version, 'Installed package version mismatch')
    assert.ok(
      (await lstat(`${archive}.unpacked`)).isDirectory(),
      'Missing installed native inventory',
    )
    archives.push({ arch, archive, sha256: await sha256(archive) })
  }
  const files = await inventory(resources, names)
  assert.ok(
    files.filter((file) => file.path.endsWith('.node')).length >= 3,
    'Missing installed native modules',
  )
  return {
    executable,
    resources,
    executableSha256: await sha256(executable),
    bootstrapSha256: await sha256(join(resources, 'app.asar')),
    archives,
    files,
    inventorySha256: digest(files),
  }
}

async function testedPackage(options, receipt) {
  assert.equal(receipt.sourceHead, options.sourceHead, 'Package receipt differs from source')
  assert.equal(receipt.version, '0.3.13')
  assert.equal(receipt.platform, options.platform)
  assert.ok(!receipt.nativeFailure, 'Packaged native gate failed')
  const arches = options.platform === 'darwin' ? ['arm64', 'x64'] : ['x64']
  assert.deepEqual(
    receipt.native.map((entry) => entry.arch).sort(),
    [...arches].sort(),
    'Missing/duplicate native slices',
  )
  const packaged = await installation(
    options.packagedExecutable,
    options.packagedResources,
    options.platform,
    '0.3.13',
  )
  for (const native of receipt.native) {
    assert.equal(native.kind, 'packaged-native-module-load')
    assert.equal(native.version, receipt.version)
    assert.equal(native.platform, receipt.platform)
    assert.ok(native.electron)
    assert.equal(native.physicalBehaviorTested, false)
    assert.equal(native.executableSha256, packaged.executableSha256)
    const archive = packaged.archives.find((entry) => entry.arch === native.arch)
    assert.equal(await realpath(native.archive), await realpath(archive.archive))
    assert.equal(native.asarSha256, archive.sha256)
    for (const name of ['@lydell/node-pty', 'koffi', 'uiohook-napi'])
      assert.equal(native.modules?.[name]?.loaded, true)
    assert.ok(native.nativeLoads?.length >= 3, 'Missing actual native-load inventory')
    for (const loaded of native.nativeLoads) {
      const physical = await realpath(loaded.path)
      assert.ok(
        contained(await realpath(`${archive.archive}.unpacked`), physical),
        'Native receipt escaped unpacked resources',
      )
      assert.equal(await sha256(physical), loaded.sha256, 'Tested native module changed')
    }
  }
  return packaged
}

export function installedPlans(installed, options, root) {
  return installed.archives.map((entry) => ({
    arch: entry.arch,
    native: {
      executable: installed.executable,
      resources: installed.resources,
      arch: entry.arch,
      executableSha256: installed.executableSha256,
      asarSha256: entry.sha256,
      dataRoot: join(root, 'native'),
    },
    functional: {
      sourceHead: options.sourceHead,
      version: '0.3.13',
      arch: entry.arch,
      executable: installed.executable,
      resources: installed.resources,
      archive: entry.archive,
      executableSha256: installed.executableSha256,
      asarSha256: entry.sha256,
      bootstrapSha256: installed.bootstrapSha256,
      fixture: options.fixture,
      dataRoot: join(root, 'functional'),
    },
  }))
}

export async function installSmoke(input, dependencies = {}) {
  const env = dependencies.env ?? process.env
  requireHostedCI(env) // Before any filesystem IO, profile preparation, or platform command.
  const platform = dependencies.platform ?? process.platform
  assert.equal(input.platform, platform, 'Wrong installer platform')
  assert.ok(BASELINE[platform], 'Unsupported installer platform')
  assert.match(input.sourceHead ?? '', /^[a-f0-9]{40}$/)
  const options = { ...input }
  for (const key of [
    'previousArtifact',
    'candidateArtifact',
    'artifactReceipt',
    'packagedExecutable',
    'packagedResources',
    'fixture',
  ]) {
    assert.ok(
      isAbsolute(options[key] ?? '') && options[key].length < 4096,
      'Absolute bounded input paths required',
    )
    options[key] = await realpath(options[key])
  }
  const runner = await realpath(env.RUNNER_TEMP)
  if (platform === 'win32') nsisArguments(join(runner, 'application'))
  const receipt = JSON.parse(await readFile(options.artifactReceipt, 'utf8'))
  const packaged = await testedPackage(options, receipt)
  const matches = receipt.files.filter((file) => file.name === candidateName(platform))
  assert.equal(matches.length, 1, 'Missing/duplicate candidate installer receipt')
  const previous = await verifyAsset(
    options.previousArtifact,
    dependencies.baseline ?? BASELINE[platform],
  )
  const candidate = await verifyAsset(options.candidateArtifact, matches[0])
  const root = await mkdtemp(join(runner, 'ari-install-upgrade-'))
  const output = {
    receiptVersion: 1,
    kind: 'installed-candidate-equivalence',
    sourceHead: options.sourceHead,
    platform,
    root,
    previous,
    candidate,
    artifactReceipt: options.artifactReceipt,
    sequence: [],
    commands: [],
    passed: false,
    osInstallerBehaviorTested: false,
    extractionOnly: platform === 'linux',
    applicationProfileStartupTested: false,
    updaterBehaviorTested: false,
    nativeBehaviorTested: false,
  }
  const run = dependencies.run ?? promisify(execFile)
  const commandEnv = isolatedEnvironment(join(root, 'environment'), env)
  for (const path of new Set(Object.values(commandEnv).filter((value) => value.startsWith(root))))
    await mkdir(path, { recursive: true })
  async function command(executable, args, label, timeout = 120_000) {
    const record = {
      label,
      executable,
      args,
      timeoutMs: timeout,
      windowsHide: true,
      completed: false,
    }
    output.commands.push(record)
    try {
      const result = await run(executable, args, {
        cwd: root,
        env: commandEnv,
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
      })
      record.completed = true
      return result
    } catch (error) {
      record.exitCode = error?.code ?? null
      record.timedOut = Boolean(error?.killed)
      record.stdout = commandText(error?.stdout)
      record.stderr = commandText(error?.stderr)
      const detail = record.stderr || record.stdout || 'no child output'
      throw new Error(`Install command failed: ${label}: ${detail}`, { cause: error })
    }
  }
  const destination = join(root, 'application')
  try {
    await mkdir(join(root, 'assets'))
    await mkdir(join(root, 'preserved-profile'))
    const prepared = await prepareProfile(join(root, 'preserved-profile'), options.fixture)
    const fixtureBefore = await inventory(join(root, 'preserved-profile'))
    output.fixture = {
      ...prepared.receipt,
      profile: prepared.profile,
      beforeSha256: digest(fixtureBefore),
      files: fixtureBefore,
    }
    if (platform === 'win32') {
      const reg = join(env.SystemRoot ?? 'C:/Windows', 'System32', 'reg.exe')
      for (const hive of ['HKCU', 'HKLM'])
        for (const view of ['32', '64']) {
          try {
            await run(reg, ['query', `${hive}\\Software\\${GUID}`, `/reg:${view}`], {
              cwd: root,
              env: commandEnv,
              windowsHide: true,
              timeout: 10_000,
              maxBuffer: 4096,
            })
            assert.fail('Hosted runner already has an Ari installation')
          } catch (error) {
            assert.ok(
              error?.code === 1 && /unable to find|cannot find/i.test(String(error.stderr)),
              'Unable to prove an unused Ari registry identity',
            )
          }
        }
      const tasklist = await command(
        join(env.SystemRoot ?? 'C:/Windows', 'System32', 'tasklist.exe'),
        ['/FI', 'IMAGENAME eq ari.exe', '/FO', 'CSV', '/NH'],
        'no-running-Ari',
        10_000,
      )
      assert.ok(!/"ari\.exe"/i.test(tasklist.stdout), 'Ari is already running on hosted runner')
      output.installationKind = 'windows-nsis-per-user-install-and-upgrade'
      output.launchPolicy = 'Assisted NSIS /S without --force-run; final unquoted /D, /currentuser'
    } else
      output.installationKind =
        platform === 'darwin'
          ? 'macos-dmg-copy-and-bundle-replacement'
          : 'linux-deb-payload-extraction-and-replacement'
    for (const asset of [previous, candidate]) {
      const staged = join(root, 'assets', asset.name)
      await copyFile(asset.path, staged)
      await verifyAsset(staged, asset)
      if (platform === 'win32') {
        await command(staged, nsisArguments(destination), `nsis-${asset.version}`)
        const registration = await command(
          join(env.SystemRoot ?? 'C:/Windows', 'System32', 'reg.exe'),
          ['query', `HKCU\\Software\\${GUID}`, '/v', 'InstallLocation', '/reg:64'],
          `registration-${asset.version}`,
          10_000,
        )
        const location = registration.stdout
          .match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/im)?.[1]
          ?.trim()
        assert.ok(location, 'Missing per-user installation registration')
        assert.equal(
          await realpath(location),
          await realpath(destination),
          'NSIS registered a different installation folder',
        )
      } else {
        if (asset === candidate) await rename(destination, join(root, 'retained-0312'))
        await mkdir(destination)
        if (platform === 'darwin') {
          const mount = join(root, `mount-${asset.version}`)
          await mkdir(mount)
          await command(
            '/usr/bin/hdiutil',
            ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, staged],
            `mount-${asset.version}`,
          )
          try {
            assert.ok(
              (await lstat(join(mount, 'ari.app'))).isDirectory(),
              'Expected Ari bundle missing from DMG',
            )
            await command(
              '/usr/bin/ditto',
              [join(mount, 'ari.app'), join(destination, 'ari.app')],
              `copy-${asset.version}`,
            )
          } finally {
            await command('/usr/bin/hdiutil', ['detach', mount], `detach-${asset.version}`, 30_000)
          }
        } else
          await command(
            '/usr/bin/dpkg-deb',
            ['--extract', staged, destination],
            `extract-deb-${asset.version}`,
          )
      }
      const app =
        platform === 'darwin'
          ? join(destination, 'ari.app', 'Contents')
          : platform === 'linux'
            ? join(destination, 'opt', 'Ari')
            : destination
      const installed = await installation(
        join(app, platform === 'darwin' ? 'MacOS/ari' : platform === 'win32' ? 'ari.exe' : 'ari'),
        join(app, platform === 'darwin' ? 'Resources' : 'resources'),
        platform,
        asset.version,
      )
      assert.ok(
        contained(await realpath(root), await realpath(installed.resources)),
        'Installed resources escaped disposable root',
      )
      assert.ok(
        contained(await realpath(root), await realpath(installed.executable)),
        'Installed executable escaped disposable root',
      )
      const fixtureAfter = await inventory(join(root, 'preserved-profile'))
      assert.deepEqual(
        fixtureAfter,
        fixtureBefore,
        'Installer changed the preserved fixture sibling',
      )
      output.sequence.push({
        version: asset.version,
        executable: installed.executable,
        resources: installed.resources,
        executableSha256: installed.executableSha256,
        archives: installed.archives,
        inventorySha256: installed.inventorySha256,
        fixtureSha256: digest(fixtureAfter),
      })
      if (asset === candidate) {
        assert.equal(
          installed.executableSha256,
          packaged.executableSha256,
          'Installed executable differs from tested package',
        )
        assert.deepEqual(
          installed.files,
          packaged.files,
          'Installed ASAR/native inventory differs from tested package',
        )
        output.installed = installed
        output.plans = installedPlans(installed, options, root)
      }
    }
    for (const name of ['native', 'functional']) await mkdir(join(root, name))
    for (const plan of output.plans)
      for (const kind of ['native', 'functional'])
        await writeFile(
          join(root, `${kind}-plan-${plan.arch}.json`),
          JSON.stringify(plan[kind], null, 2) + '\n',
          { flag: 'wx' },
        )
    output.fixture.afterSha256 = output.sequence.at(-1).fixtureSha256
    output.osInstallerBehaviorTested = platform === 'win32'
    output.passed = true
    return output
  } catch (error) {
    output.failure = String(error).slice(0, 2048)
    throw new Error(
      `Install verification failed; retained ${root}/install-receipt.json: ${output.failure}`,
      {
        cause: error,
      },
    )
  } finally {
    await writeFile(join(root, 'install-receipt.json'), JSON.stringify(output, null, 2) + '\n', {
      flag: 'wx',
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireHostedCI()
    assert.equal(process.argv.length, 3, 'Pass one reviewed install JSON input')
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      windowsHide: true,
      encoding: 'utf8',
    }).trim()
    assert.equal(head, process.env.CANDIDATE_SHA, 'Checkout differs from reviewed candidate')
    assert.equal(input.sourceHead, head, 'Install input differs from checkout')
    console.log(JSON.stringify(await installSmoke(input), null, 2))
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
