// Opt-in, hash-pinned launcher. Safe to review without executing a packaged app.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, createReadStream } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

export function archivePath(resources, arch) {
  const split = join(resources, `app-${arch}.asar`)
  return existsSync(split) ? split : join(resources, 'app.asar')
}

export function isolatedEnvironment(data, source = process.env) {
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: data,
    USERPROFILE: data,
    APPDATA: join(data, 'roaming'),
    LOCALAPPDATA: join(data, 'local'),
    XDG_CONFIG_HOME: join(data, 'config'),
    XDG_DATA_HOME: join(data, 'data'),
    XDG_CACHE_HOME: join(data, 'cache'),
    TEMP: join(data, 'temp'),
    TMP: join(data, 'temp'),
    TMPDIR: join(data, 'temp'),
  }
  // No Ari control credentials, NODE_OPTIONS, loader overrides or dictation flags.
  // Linux addons open the disposable CI X display even when hooks are not started.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY'])
    if (source[key] !== undefined) env[key] = source[key]
  return env
}

export function executionCommand(
  executable,
  args,
  arch,
  platform = process.platform,
  hostArch = process.arch,
) {
  // A universal app needs two real executions. Missing Rosetta must fail the x64 leg.
  return platform === 'darwin' && arch !== hostArch
    ? {
        executable: '/usr/bin/arch',
        args: [arch === 'x64' ? '-x86_64' : '-arm64', executable, ...args],
      }
    : { executable, args }
}

export async function smoke(options, run = promisify(execFile)) {
  const { executable, resources, arch, executableSha256, asarSha256, dataRoot } = options
  for (const path of [executable, resources, dataRoot])
    assert.ok(isAbsolute(path), 'Use absolute paths')
  assert.ok(['x64', 'arm64'].includes(arch), 'Choose the native target architecture')
  for (const hash of [executableSha256, asarSha256])
    assert.match(
      hash ?? '',
      /^[a-f0-9]{64}$/i,
      'Exact artifact hashes from the receipt are required',
    )
  const archive = archivePath(resources, arch)
  assert.equal(
    await sha256(executable),
    executableSha256.toLowerCase(),
    'Executable receipt mismatch',
  )
  assert.equal(await sha256(archive), asarSha256.toLowerCase(), 'Archive receipt mismatch')
  await mkdir(dataRoot, { recursive: true })
  const data = await mkdtemp(join(dataRoot, 'native-smoke-'))
  const env = isolatedEnvironment(data)
  for (const path of new Set([
    data,
    ...Object.values(env).filter((value) => value.startsWith(data)),
  ]))
    await mkdir(path, { recursive: true })
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'release-native-probe.mjs')
  const command = executionCommand(executable, [probe, archive, arch], arch)
  const { stdout, stderr } = await run(command.executable, command.args, {
    cwd: data,
    env,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })
  const result = JSON.parse(stdout.trim())
  assert.equal(result.kind, 'packaged-native-module-load')
  assert.equal(result.arch, arch)
  assert.equal(result.archive, archive)
  assert.equal(result.physicalBehaviorTested, false)
  assert.ok(result.electron, 'An ordinary Node process is not packaged Electron proof')
  return { ...result, executableSha256, asarSha256, isolatedData: data, stderr }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keys = {
    '--executable': 'executable',
    '--resources': 'resources',
    '--arch': 'arch',
    '--executable-sha256': 'executableSha256',
    '--asar-sha256': 'asarSha256',
    '--data-root': 'dataRoot',
  }
  try {
    const options = {}
    const args = process.argv.slice(2)
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(keys[args[i]] && args[i + 1], 'Pass only the six documented key/value options')
      options[keys[args[i]]] = args[i + 1]
    }
    console.log(JSON.stringify(await smoke(options), null, 2))
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
