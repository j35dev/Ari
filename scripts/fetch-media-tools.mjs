#!/usr/bin/env node
// Fetches pinned yt-dlp + ffmpeg into apps/desktop/resources/cliamp/bin/<target>/
// beside the Cliamp binary so the daemon PATH finds them.
//
//   node scripts/fetch-media-tools.mjs
//   node scripts/fetch-media-tools.mjs --all
//   node scripts/fetch-media-tools.mjs --target win32-x64 [--force]

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_DIR = join(ROOT, 'apps', 'desktop', 'resources', 'cliamp')
const MANIFEST_PATH = join(VENDOR_DIR, 'media-tools.json')

function fail(message) {
  console.error(`fetch-media-tools: ${message}`)
  process.exit(1)
}

function hostTargets() {
  if (process.platform === 'darwin') return ['darwin-x64', 'darwin-arm64']
  if (process.platform === 'win32') return ['win32-x64']
  if (process.platform === 'linux') return [process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64']
  fail(`unsupported host platform: ${process.platform}`)
  return []
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function download(url) {
  const response = await globalThis.fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function fetchBinary(kind, version, baseUrl, entry, targetDir, force) {
  const dest = join(targetDir, entry.binary)
  const stamp = join(targetDir, `.${kind}.json`)
  if (!force && existsSync(dest) && existsSync(stamp)) {
    try {
      const saved = JSON.parse(readFileSync(stamp, 'utf8'))
      if (saved.version === version && (!entry.sha256 || saved.sha256 === entry.sha256)) {
        console.log(`fetch-media-tools: ${kind} ${entry.binary} already matches ${version}`)
        return
      }
    } catch {
      /* refetch */
    }
  }
  const url = `${baseUrl}/${entry.asset}`
  console.log(`fetch-media-tools: downloading ${entry.asset} ...`)
  const buffer = await download(url)
  const digest = sha256(buffer)
  if (entry.sha256 && digest !== entry.sha256) {
    throw new Error(`checksum mismatch for ${entry.asset}: expected ${entry.sha256}, got ${digest}`)
  }
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(dest, buffer)
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
  writeFileSync(stamp, JSON.stringify({ version, sha256: digest }, null, 2))
  console.log(`fetch-media-tools: ${kind} ${entry.binary} ready (${version})`)
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  let targets
  if (args.includes('--all')) targets = Object.keys(manifest.ytDlp.targets)
  else {
    const at = args.indexOf('--target')
    targets = at === -1 ? hostTargets() : [args[at + 1]].filter((t) => typeof t === 'string')
    if (targets.length === 0) fail('usage: fetch-media-tools.mjs [--all] [--target <key>] [--force]')
  }
  const ytBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${manifest.ytDlp.version}`
  const ffBase = `https://github.com/eugeneware/ffmpeg-static/releases/download/${manifest.ffmpeg.version}`
  for (const target of targets) {
    const dir = join(VENDOR_DIR, 'bin', target)
    const yt = manifest.ytDlp.targets[target]
    const ff = manifest.ffmpeg.targets[target]
    if (!yt) {
      console.warn(`fetch-media-tools: no yt-dlp pin for ${target}`)
      continue
    }
    try {
      await fetchBinary('yt-dlp', manifest.ytDlp.version, ytBase, yt, dir, force)
      if (ff) await fetchBinary('ffmpeg', manifest.ffmpeg.version, ffBase, ff, dir, force)
    } catch (error) {
      if (existsSync(join(dir, yt.binary))) {
        console.warn(
          `fetch-media-tools: keeping existing ${target} tools (${error instanceof Error ? error.message : String(error)})`,
        )
        continue
      }
      fail(`cannot provide ${target}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

await main()
