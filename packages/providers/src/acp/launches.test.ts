import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acpAdapterSpec, findNpxCommand, resolveAcpLaunch } from './launches'
import type { DetectEnvironment } from '../types'

const ENV: DetectEnvironment = {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  pathEnv: '/usr/local/bin:/usr/bin',
  homeDir: '/home/tester',
}

describe('resolveAcpLaunch', () => {
  it('launches npx adapters at a pinned version for kinds that need one', async () => {
    const npxPath = await makeFakeNpx()
    const env: DetectEnvironment = { ...ENV, pathEnv: dirname(npxPath) }
    const launch = resolveAcpLaunch('claude', { cliBinaryPath: join(dirname(npxPath), 'claude') }, env)
    expect(launch).not.toBeNull()
    expect(launch?.command).toContain('npx')
    // Pinned, not bare: two users on one Ari build must run the same adapter.
    expect(launch?.args).toEqual(['-y', acpAdapterSpec('claude')])
    expect(launch?.args[1]).toMatch(/^@agentclientprotocol\/claude-agent-acp@\d+\.\d+\.\d+$/)
    expect(launch?.label).toContain(acpAdapterSpec('claude') as string)
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

describe('acpAdapterSpec', () => {
  it('pins every npx adapter to an exact version', () => {
    for (const kind of ['claude', 'codex', 'pi'] as const) {
      expect(acpAdapterSpec(kind, {})).toMatch(/@\d+\.\d+\.\d+$/)
    }
  })

  it('answers null for kinds that need no adapter', () => {
    expect(acpAdapterSpec('opencode', {})).toBeNull()
    expect(acpAdapterSpec('ari-core', {})).toBeNull()
  })

  it('reads a bare override as a version and a qualified one as a whole spec', () => {
    expect(acpAdapterSpec('claude', { ARI_ACP_ADAPTER_CLAUDE: '0.71.0' })).toBe(
      '@agentclientprotocol/claude-agent-acp@0.71.0',
    )
    expect(acpAdapterSpec('claude', { ARI_ACP_ADAPTER_CLAUDE: 'latest' })).toBe(
      '@agentclientprotocol/claude-agent-acp@latest',
    )
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: 'my-fork/pi-acp' })).toBe('my-fork/pi-acp')
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: 'pi-acp@0.0.34' })).toBe('pi-acp@0.0.34')
  })

  it('ignores a blank override rather than building a dangling spec', () => {
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: '   ' })).toBe(acpAdapterSpec('pi', {}))
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
    // win32 well-known dirs are gated on localAppData; omitting it plus an
    // empty PATH is empty on every host (linux CI still has /usr/bin/npx).
    expect(
      findNpxCommand({ platform: 'win32', pathEnv: '', homeDir: '/nonexistent-home' }),
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
