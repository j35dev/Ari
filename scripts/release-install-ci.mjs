// Hosted-only installer orchestration. All profiles and installs are disposable.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BASELINE, installSmoke, verifyAsset } from './release-install-smoke.mjs'
import { smoke as nativeSmoke } from './release-native-smoke.mjs'
import { smoke as functionalSmoke } from './release-functional-smoke.mjs'
import { contained, requireHostedCI } from './release-functional-support.mjs'

export function installInput(receipt, context) {
  assert.equal(receipt.sourceHead, context.sourceHead)
  assert.equal(receipt.platform, context.platform)
  assert.equal(receipt.version, '0.3.14')
  assert.ok(!receipt.nativeFailure, 'Failed packaged native gate')
  const baseline = BASELINE[context.platform]
  assert.ok(baseline, 'Unsupported install platform')
  const candidateName = baseline.name.replace('0.3.13', '0.3.14')
  assert.equal(receipt.files.filter((file) => file.name === candidateName).length, 1)
  const app =
    context.platform === 'darwin'
      ? join(context.dist, 'mac-universal/ari.app/Contents')
      : join(context.dist, context.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked')
  return {
    sourceHead: context.sourceHead,
    platform: context.platform,
    previousArtifact: join(context.downloadRoot, baseline.name),
    candidateArtifact: join(context.dist, candidateName),
    artifactReceipt: join(context.dist, 'candidate-artifacts.json'),
    packagedExecutable: join(
      app,
      context.platform === 'darwin'
        ? 'MacOS/ari'
        : context.platform === 'win32'
          ? 'ari.exe'
          : 'ari',
    ),
    packagedResources: join(app, context.platform === 'darwin' ? 'Resources' : 'resources'),
    fixture: context.fixture,
  }
}

async function main() {
  requireHostedCI() // Before download, install or any packaged execution.
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
  assert.equal(sourceHead, process.env.CANDIDATE_SHA)
  const dist = resolve('dist')
  const receipt = JSON.parse(await readFile(join(dist, 'candidate-artifacts.json'), 'utf8'))
  const runner = await realpath(process.env.RUNNER_TEMP)
  const downloadRoot = await mkdtemp(join(runner, 'ari-install-assets-'))
  const input = installInput(receipt, {
    sourceHead,
    platform: process.platform,
    dist,
    downloadRoot,
    fixture: resolve('apps/desktop/src/main/testing/release-profile-0312.fixture.json'),
  })
  const baseline = BASELINE[process.platform]
  const response = await globalThis.fetch(
    `https://github.com/j35dev/Ari/releases/download/v0.3.13/${baseline.name}`,
    {
      signal: globalThis.AbortSignal.timeout(120_000),
    },
  )
  assert.ok(response.ok && response.body, `Baseline download failed: ${response.status}`)
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(input.previousArtifact, { flags: 'wx' }),
  )
  await verifyAsset(input.previousArtifact, baseline)
  await writeFile(join(downloadRoot, 'install-input.json'), JSON.stringify(input, null, 2) + '\n')
  const installed = await installSmoke(input)
  const proof = {
    sourceHead,
    platform: process.platform,
    installReceipt: join(installed.root, 'install-receipt.json'),
    installation: installed,
    native: [],
    functional: [],
    passed: false,
  }
  try {
    if (process.platform === 'linux') {
      // Extraction has not executed deb postinst. Keep Chromium sandboxing enabled.
      const helper = await realpath(join(installed.installed.executable, '..', 'chrome-sandbox'))
      assert.ok(
        contained(await realpath(installed.root), helper),
        'Sandbox helper escaped owned install',
      )
      for (const args of [
        ['chown', 'root:root', helper],
        ['chmod', '4755', helper],
      ])
        await promisify(execFile)('/usr/bin/sudo', args, { windowsHide: true, timeout: 10_000 })
    }
    for (const plan of installed.plans) {
      const native = await nativeSmoke(plan.native)
      proof.native.push(native)
      const functional = await functionalSmoke(plan.functional)
      assert.equal(functional.passed, true)
      proof.functional.push({ arch: plan.arch, suiteRoot: functional.suiteRoot })
    }
    proof.passed = true
  } catch (error) {
    proof.failure = String(error).slice(0, 2048)
    throw error
  } finally {
    await writeFile(
      join(installed.root, 'installed-probes.json'),
      JSON.stringify(proof, null, 2) + '\n',
    )
  }
  console.log(JSON.stringify({ sourceHead, root: installed.root, passed: proof.passed }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
