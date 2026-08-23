import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findNpxCommand, resolveAcpLaunch } from './launches'
import type { DetectEnvironment } from '../types'

const ENV: DetectEnvironment = {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  pathEnv: '/usr/local/bin:/usr/bin',
  homeDir: '/home/tester',
}

describe('resolveAcpLaunch', () => {
  it('launches npx adapters for kinds that need one', async () => {
    const npxPath = await makeFakeNpx()
    const env: DetectEnvironment = { ...ENV, pathEnv: dirname(npxPath) }
    const launch = resolveAcpLaunch('claude', { cliBinaryPath: join(dirname(npxPath), 'claude') }, env)
    expect(launch).not.toBeNull()
    expect(launch?.command).toContain('npx')
    expect(launch?.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })

  it('launches native ACP servers with their own binary', () => {
    const opencode = resolveAcpLaunch('opencode', { cliBinaryPath: '/usr/bin/opencode' }, ENV)
    expect(opencode).toEqual({ label: 'opencode (native ACP)', command: '/usr/bin/opencode', args: ['acp'] })
    const hermes = resolveAcpLaunch('hermes', { cliBinaryPath: '/usr/bin/hermes' }, ENV)
    expect(hermes?.args).toEqual(['acp'])
    const grok = resolveAcpLaunch('grok', { cliBinaryPath: '/usr/bin/grok' }, ENV)
    expect(grok?.args).toEqual(['agent', 'stdio'])
  })

  it('returns null when the CLI itself is not installed', () => {
    expect(resolveAcpLaunch('claude', { cliBinaryPath: null }, ENV)).toBeNull()
    expect(resolveAcpLaunch('opencode', { cliBinaryPath: null }, ENV)).toBeNull()
  })

  it('returns null when ACP is disabled via env override', () => {
    expect(
      resolveAcpLaunch('claude', { cliBinaryPath: '/usr/local/bin/claude', envOverride: '0' }, ENV),
    ).toBeNull()
    process.env['ARI_ACP'] = '0'
    try {
      expect(resolveAcpLaunch('codex', { cliBinaryPath: '/usr/bin/codex' }, ENV)).toBeNull()
    } finally {
      delete process.env['ARI_ACP']
    }
  })

  it('returns null for kinds without an ACP transport story (ari-core)', () => {
    expect(resolveAcpLaunch('ari-core', { cliBinaryPath: '/x' }, ENV)).toBeNull()
  })
})

describe('findNpxCommand', () => {
  it('finds npx on the PATH when present', async () => {
    const npxPath = await makeFakeNpx()
    const found = findNpxCommand({
      platform: ENV.platform,
      pathEnv: dirname(npxPath),
      homeDir: ENV.homeDir,
    })
    expect(found).not.toBeNull()
  })

  it('returns null when nowhere to look', () => {
    expect(
      findNpxCommand({ platform: 'linux', pathEnv: '', homeDir: '/nonexistent-home' }),
    ).toBeNull()
  })
})

/** Creates a temp dir containing a fake npx so resolution has a real hit. */
async function makeFakeNpx(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-npx-'))
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const path = join(dir, name)
  await writeFile(path, '@echo off\n', 'utf8')
  return path
}

afterEach(() => {
  delete process.env['ARI_ACP']
})
