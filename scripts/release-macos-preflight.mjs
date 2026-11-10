// CI-only startup diagnostics. No Ari entry, addon, microphone or hook is loaded.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { executionCommand, isolatedEnvironment, sha256 } from './release-native-smoke.mjs'

export const STOCK_X64 = {
  name: 'electron-v43.4.1-darwin-x64.zip',
  bytes: 124311852,
  sha256: '4fd0f1826660a94216a0633600a3c3e2cd87ee9e4bc6f0e1edf717ad8e30c10b',
}

// Read an existing locked builder/get cache only. No downloader or cache writes.
export async function cachedStockRuntime(cacheRoot, dataRoot, run, expected = STOCK_X64) {
  const cache = await realpath(cacheRoot)
  const directories = await readdir(cache, { withFileTypes: true })
  assert.ok(directories.length < 1000, 'Unbounded Electron cache inventory')
  const candidates = [
    cache,
    ...directories
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(cache, entry.name)),
  ]
  let zip
  for (const directory of candidates) {
    const path = join(directory, expected.name)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) continue
    if ((await sha256(path)) === expected.sha256) {
      zip = path
      break
    }
  }
  assert.ok(zip, 'Pinned stock x64 Electron ZIP missing from existing cache')
  await mkdir(dataRoot, { recursive: true })
  const root = await mkdtemp(join(dataRoot, 'stock-x64-'))
  await run('/usr/bin/ditto', ['-x', '-k', zip, root], {
    cwd: root,
    env: isolatedEnvironment(root),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  })
  const executable = join(root, 'Electron.app/Contents/MacOS/Electron')
  assert.ok((await lstat(executable)).isFile(), 'Missing extracted stock executable')
  return {
    zip,
    zipSha256: expected.sha256,
    zipBytes: expected.bytes,
    executable,
    executableSha256: await sha256(executable),
  }
}

export async function preflight(executable, dataRoot, run, stock) {
  assert.equal(typeof run, 'function', 'An explicit launcher is required')
  await mkdir(dataRoot, { recursive: true })
  const data = await mkdtemp(join(dataRoot, 'macos-preflight-'))
  const env = isolatedEnvironment(data)
  for (const value of Object.values(env).filter((value) => value.startsWith(data)))
    await mkdir(value, { recursive: true })
  const receipt = { executableSha256: await sha256(executable), stock, commands: [] }
  const expression =
    "require('node:fs').writeSync(2,'entered-eval\\n');if(process.arch!=='x64'||!process.versions.electron)process.exit(2);require('node:fs').writeSync(1,JSON.stringify({arch:process.arch,electron:process.versions.electron,node:process.versions.node})+'\\n');require('node:fs').writeSync(2,'completed-eval\\n')"
  const plans = [
    {
      name: 'rosetta-package',
      executable: '/usr/sbin/pkgutil',
      args: ['--pkg-info', 'com.apple.pkg.RosettaUpdateAuto'],
      required: false,
    },
    {
      name: 'translated-system-runtime',
      executable: '/usr/bin/arch',
      args: ['-x86_64', '/usr/bin/uname', '-m'],
      required: true,
    },
    {
      name: 'translated-packaged-node',
      ...executionCommand(executable, ['-e', expression], 'x64', 'darwin', 'arm64'),
      required: true,
    },
  ]
  if (stock?.executable)
    plans.push({
      name: 'translated-stock-node',
      ...executionCommand(stock.executable, ['-e', expression], 'x64', 'darwin', 'arm64'),
      required: false,
    })
  for (const plan of plans) {
    const started = Date.now()
    let sampleTimer, sampleTask
    try {
      const execution = run(plan.executable, plan.args, {
        cwd: data,
        env,
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      })
      if (
        plan.name === 'translated-packaged-node' &&
        Number.isInteger(execution.child?.pid) &&
        execution.child.pid > 0
      ) {
        const pid = execution.child.pid
        receipt.ownedChildPid = pid
        sampleTimer = globalThis.setTimeout(() => {
          if (execution.child.exitCode !== null || execution.child.signalCode !== null) return
          const report = join(data, 'owned-x64-startup-sample.txt')
          sampleTask = run('/usr/bin/sample', [String(pid), '1', '1', '-file', report], {
            cwd: data,
            env,
            windowsHide: true,
            timeout: 3000,
            maxBuffer: 256 * 1024,
          }).then(
            () => {
              receipt.sample = { pid, report, success: true }
            },
            (error) => {
              receipt.sample = {
                pid,
                report,
                success: false,
                message: String(error).slice(0, 2000),
              }
            },
          )
        }, 5000)
      }
      const output = await execution
      receipt.commands.push({
        name: plan.name,
        required: plan.required,
        success: true,
        elapsedMs: Date.now() - started,
        stdout: output.stdout.trim(),
        stderr: output.stderr.trim(),
      })
    } catch (error) {
      receipt.commands.push({
        name: plan.name,
        required: plan.required,
        success: false,
        elapsedMs: Date.now() - started,
        code: error?.code ?? null,
        signal: error?.signal ?? null,
        killed: error?.killed ?? false,
        stdout: String(error?.stdout ?? '').slice(0, 4096),
        stderr: String(error?.stderr ?? '').slice(0, 4096),
      })
    } finally {
      globalThis.clearTimeout(sampleTimer)
      if (sampleTask) await sampleTask
    }
  }
  return receipt
}

async function main() {
  assert.equal(process.env.CI, 'true', 'Packaged startup preflight is CI-only')
  assert.equal(process.platform, 'darwin', 'This preflight requires the macOS CI runner')
  assert.equal(process.arch, 'arm64', 'This preflight diagnoses the ARM64 runner translation path')
  const root = resolve('dist')
  const head = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim()
  assert.equal(head, process.env.CANDIDATE_SHA, 'Checkout differs from exact candidate')
  const dataRoot = resolve(process.env.RUNNER_TEMP, 'ari-macos-preflight')
  let stock
  try {
    stock = await cachedStockRuntime(
      process.env.electron_config_cache ?? join(homedir(), 'Library/Caches/electron'),
      dataRoot,
      promisify(execFile),
    )
  } catch (error) {
    stock = { preparationFailure: String(error).slice(0, 2000) }
  }
  const receipt = {
    sourceHead: head,
    ...(await preflight(
      join(root, 'mac-universal/ari.app/Contents/MacOS/ari'),
      dataRoot,
      promisify(execFile),
      stock,
    )),
  }
  await writeFile(join(root, 'macos-preflight.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  assert.ok(
    receipt.commands.every((entry) => !entry.required || entry.success),
    'Required translated runtime preflight failed',
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
