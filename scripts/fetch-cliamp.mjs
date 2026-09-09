#!/usr/bin/env node
// Fetches the pinned Cliamp release binaries into
// apps/desktop/resources/cliamp/bin/<target>/ for packaging.
//
//   node scripts/fetch-cliamp.mjs                 # host platform targets
//   node scripts/fetch-cliamp.mjs --all           # every pinned target
//   node scripts/fetch-cliamp.mjs --target linux-x64 [--force]
//
// Idempotent and offline-safe: targets whose stamped binary already matches
// the pin are skipped without touching the network. Exits non-zero only when
// a required binary is missing and cannot be fetched.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_DIR = join(ROOT, 'apps', 'desktop', 'resources', 'cliamp')
const MANIFEST_PATH = join(VENDOR_DIR, 'cliamp.json')

function fail(message) {
  console.error(`fetch-cliamp: ${message}`)
  process.exit(1)
}

function hostTargets() {
  if (process.platform === 'darwin') return ['darwin-x64', 'darwin-arm64']
  if (process.platform === 'win32') return ['win32-x64']
  if (process.platform === 'linux') return [process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64']
  fail(`unsupported host platform: ${process.platform}`)
  return []
}

function stampPath(targetDir) {
  return join(targetDir, '.fetched.json')
}

function stampedOk(targetDir, manifest, entry) {
  if (!existsSync(join(targetDir, entry.binary)) || !existsSync(stampPath(targetDir))) return false
  try {
    const stamp = JSON.parse(readFileSync(stampPath(targetDir), 'utf8'))
    return stamp.version === manifest.version && stamp.sha256 === entry.sha256
  } catch {
    return false
  }
}

async function download(url, dest) {
  const response = await globalThis.fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, buffer)
  return buffer
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function extractZip(zipPath, destDir) {
  // No single tool reads zips everywhere (GNU tar cannot), so each OS uses
  // its own built-in: PowerShell on Windows, Info-ZIP unzip elsewhere.
  // Everything stays in argv arrays — paths with spaces need no quoting.
  if (process.platform === 'win32') {
    const expandDir = `${destDir}.expand`
    rmSync(expandDir, { recursive: true, force: true })
    mkdirSync(expandDir, { recursive: true })
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:ARI_CLIAMP_ZIP -DestinationPath $env:ARI_CLIAMP_DEST -Force',
      ],
      {
        stdio: 'pipe',
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, ARI_CLIAMP_ZIP: zipPath, ARI_CLIAMP_DEST: expandDir },
      },
    )
    if (result.status !== 0) {
      throw new Error(`Expand-Archive failed: ${String(result.stderr ?? result.error ?? '')}`)
    }
    liftTopFolder(expandDir, destDir)
    rmSync(expandDir, { recursive: true, force: true })
    return
  }
  const result = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], {
    stdio: 'pipe',
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `unzip failed (is Info-ZIP unzip installed?): ${String(result.stderr ?? result.error ?? '')}`,
    )
  }
  liftTopFolder(destDir, destDir)
}

/**
 * The Windows asset nests everything under one top-level folder; lift its
 * children up so the exe keeps its codec DLLs beside it in bin/<target>/.
 */
function liftTopFolder(scanDir, destDir) {
  const entries = readdirSync(scanDir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) return
  const top = join(scanDir, entries[0].name)
  for (const entry of readdirSync(top)) {
    renameSync(join(top, entry), join(destDir, entry))
  }
}

async function fetchTarget(manifest, target, force) {
  const entry = manifest.targets[target]
  if (!entry) fail(`target ${target} is not pinned in cliamp.json`)
  const targetDir = join(VENDOR_DIR, 'bin', target)
  if (!force && stampedOk(targetDir, manifest, entry)) {
    console.log(`fetch-cliamp: ${target} already matches ${manifest.version}, skipping`)
    return
  }
  const url = `https://github.com/bjarneo/cliamp/releases/download/${manifest.version}/${entry.asset}`
  const workDir = join(tmpdir(), `ari-cliamp-${target}-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  try {
    console.log(`fetch-cliamp: downloading ${entry.asset} ...`)
    const assetPath = join(workDir, entry.asset)
    const buffer = await download(url, assetPath)
    const digest = sha256(buffer)
    if (digest !== entry.sha256) {
      throw new Error(
        `checksum mismatch for ${entry.asset}: expected ${entry.sha256}, got ${digest}`,
      )
    }
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    if (entry.asset.endsWith('.zip')) {
      extractZip(assetPath, targetDir)
    } else {
      copyFileSync(assetPath, join(targetDir, entry.binary))
    }
    const binaryPath = join(targetDir, entry.binary)
    if (!existsSync(binaryPath)) throw new Error(`asset did not contain ${entry.binary}`)
    if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)
    writeFileSync(
      stampPath(targetDir),
      JSON.stringify({ version: manifest.version, sha256: entry.sha256 }, null, 2),
    )
    console.log(`fetch-cliamp: ${target} ready (${manifest.version})`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  let targets
  if (args.includes('--all')) {
    targets = Object.keys(manifest.targets)
  } else {
    const at = args.indexOf('--target')
    if (at === -1) {
      const host = hostTargets()
      targets = host.filter((target) => manifest.targets[target] !== undefined)
      for (const target of host.filter((candidate) => !targets.includes(candidate))) {
        console.log(`fetch-cliamp: ${target} has no self-contained binary, skipping`)
      }
    } else {
      targets = [args[at + 1]].filter((target) => typeof target === 'string')
      if (targets.length === 0) fail('usage: fetch-cliamp.mjs [--all] [--target <key>] [--force]')
    }
  }
  for (const target of targets) {
    try {
      await fetchTarget(manifest, target, force)
    } catch (error) {
      const targetDir = join(VENDOR_DIR, 'bin', target)
      const entry = manifest.targets[target]
      if (entry && existsSync(join(targetDir, entry.binary))) {
        console.warn(
          `fetch-cliamp: keeping existing ${target} binary (fetch failed: ${error instanceof Error ? error.message : String(error)})`,
        )
        continue
      }
      fail(`cannot provide ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

await main()
