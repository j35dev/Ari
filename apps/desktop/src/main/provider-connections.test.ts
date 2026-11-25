import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { DetectEnvironment, Detection } from '@ari/providers/types'
import { detectConnection, unavailableReason } from './provider-connections'

const ENV: DetectEnvironment = { platform: 'linux', pathEnv: '', homeDir: '/home/t' }

const found = (binaryPath: string | null): Detection => ({
  kind: 'claude',
  installed: binaryPath !== null,
  binaryPath,
  version: null,
  authStatus: 'unknown',
})

describe('detectConnection', () => {
  it('names the OpenCode server generation it will talk to, unless a transport is pinned', async () => {
    const opencode = (version: string): Detection => ({
      ...found('/bin/opencode'),
      kind: 'opencode',
      version,
    })
    const label = async (version: string) =>
      (await detectConnection('opencode', ENV, defaultSettings, async () => opencode(version)))
        .transport
    expect(await label('opencode2 v0.0.0-beta-1')).toEqual({
      mode: 'sdk',
      label: 'OpenCode 2 server',
      available: true,
    })
    expect((await label('1.19.6'))?.label).toBe('OpenCode server')
    vi.stubEnv('ARI_OPENCODE_TRANSPORT', 'acp')
    try {
      expect((await label('1.19.6'))?.mode).not.toBe('sdk')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("hands the detector that provider's own settings", async () => {
    const detect = vi.fn(async () => found(null))
    const settings = {
      ...defaultSettings,
      providers: {
        ...defaultSettings.providers,
        claude: { ...defaultSettings.providers.claude, enabled: false, binaryPath: '/opt/claude' },
      },
    }
    await detectConnection('claude', ENV, settings, detect)
    await detectConnection('codex', ENV, settings, detect)
    expect(detect).toHaveBeenNthCalledWith(
      1,
      'claude',
      ENV,
      expect.objectContaining({ enabled: false, binaryPath: '/opt/claude' }),
    )
    expect(detect).toHaveBeenNthCalledWith(
      2,
      'codex',
      ENV,
      expect.objectContaining({ enabled: true, binaryPath: '' }),
    )
  })

  it('describes the transport only for a CLI that was found', async () => {
    const describe = vi.fn(() => ({ mode: 'cli' as const, label: 'Command line' }))
    const missing = await detectConnection(
      'claude',
      ENV,
      defaultSettings,
      async () => found(null),
      describe,
    )
    expect(missing.transport).toBeUndefined()
    expect(describe).not.toHaveBeenCalled()

    const present = await detectConnection(
      'claude',
      ENV,
      defaultSettings,
      async () => found('/usr/bin/claude'),
      describe,
    )
    expect(present.transport).toEqual({ mode: 'cli', label: 'Claude Agent SDK', available: true })
    expect(describe).not.toHaveBeenCalled()
  })

  it('hands Ari Core its own on/off setting', async () => {
    const detect = vi.fn(async () => ({ ...found(null), kind: 'ari-core' as const }))
    await detectConnection('ari-core', ENV, defaultSettings, detect)
    expect(detect).toHaveBeenCalledWith('ari-core', ENV, { enabled: true })
    await detectConnection(
      'ari-core',
      ENV,
      { ...defaultSettings, ariCore: { enabled: false } },
      detect,
    )
    expect(detect).toHaveBeenLastCalledWith('ari-core', ENV, { enabled: false })
  })
})

describe('unavailableReason', () => {
  it('refuses an installed ACP-only provider when its transport is disabled', () => {
    expect(
      unavailableReason('qoder', {
        ...found('/opt/qodercli'),
        kind: 'qoder',
        transport: { mode: 'acp', available: false, label: 'ACP unavailable', note: 'Enable ACP.' },
      }),
    ).toBe('Qoder cannot start: Enable ACP.')
  })
  it('has nothing to say when the CLI was found or was never looked for', () => {
    expect(unavailableReason('claude', found('/usr/bin/claude'))).toBeNull()
    expect(unavailableReason('claude', undefined)).toBeNull()
  })

  it('says a provider is off from the setting alone, before any detection', () => {
    const off = 'Hermes is turned off. Turn it on in Settings > Providers to use this session.'
    expect(unavailableReason('hermes', undefined, false)).toBe(off)
    // Even when the last round still found it installed.
    expect(unavailableReason('hermes', found('/usr/bin/hermes'), false)).toBe(off)
  })

  it('tells a provider that is off from one whose path is wrong from one that is missing', () => {
    expect(unavailableReason('claude', { ...found(null), enabled: false })).toBe(
      'Claude is turned off. Turn it on in Settings > Providers to use this session.',
    )
    expect(
      unavailableReason('opencode', {
        ...found(null),
        enabled: true,
        pathSource: 'custom',
        pathProblem: 'No file exists at this path.',
      }),
    ).toBe(
      'OpenCode cannot start from the path set in Settings > Providers: No file exists at this path.',
    )
    expect(unavailableReason('codex', { ...found(null), enabled: true })).toBe(
      'Codex is not installed. Install it or set its path in Settings > Providers.',
    )
  })
})
