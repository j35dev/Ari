import { describe, expect, it } from 'vitest'
import type { Detection } from '@ari/providers/types'
import { partitionProviders } from './provider-readiness'

function detection(overrides: Partial<Detection> & { kind: Detection['kind'] }): Detection {
  return {
    installed: false,
    binaryPath: null,
    version: null,
    authStatus: 'unknown',
    ...overrides,
  }
}

const installedClaude = detection({
  kind: 'claude',
  installed: true,
  binaryPath: 'C:/bin/claude',
  authStatus: 'authenticated',
})

/** The reporter's case: Claude present and working, Codex genuinely absent. */
const absentCodex = detection({ kind: 'codex' })

describe('partitionProviders', () => {
  it('offers an installed, authenticated provider', () => {
    const { ready } = partitionProviders([installedClaude])
    expect(ready.map((d) => d.kind)).toEqual(['claude'])
  })

  it('offers an installed provider whose auth verdict is unknown', () => {
    // "Ari cannot tell" is not "logged out" — Claude Code with an
    // ANTHROPIC_API_KEY has no credentials file and must still be offered.
    const { ready } = partitionProviders([
      detection({ kind: 'claude', installed: true, binaryPath: 'C:/bin/claude' }),
    ])
    expect(ready.map((d) => d.kind)).toEqual(['claude'])
  })

  it('withholds an installed provider that is known to be logged out', () => {
    const { ready, withheld } = partitionProviders([
      detection({
        kind: 'codex',
        installed: true,
        binaryPath: 'C:/bin/codex',
        authStatus: 'unauthenticated',
      }),
    ])
    expect(ready).toEqual([])
    expect(withheld.map((entry) => entry.detection.kind)).toEqual(['codex'])
  })

  it('withholds a provider that is not installed', () => {
    const { ready, withheld } = partitionProviders([absentCodex])
    expect(ready).toEqual([])
    expect(withheld.map((entry) => entry.detection.kind)).toEqual(['codex'])
  })

  it('never offers ari-core, which has no binary of its own', () => {
    const { ready } = partitionProviders([detection({ kind: 'ari-core' })])
    expect(ready.map((d) => d.kind)).toEqual(['ari-core'])
  })

  it('keeps detection order in both partitions', () => {
    const { ready, withheld } = partitionProviders([
      absentCodex,
      installedClaude,
      detection({ kind: 'pi', installed: true, binaryPath: 'C:/bin/pi' }),
    ])
    expect(ready.map((d) => d.kind)).toEqual(['claude', 'pi'])
    expect(withheld.map((entry) => entry.detection.kind)).toEqual(['codex'])
  })

  it('explains why a provider was withheld', () => {
    const { withheld } = partitionProviders([absentCodex])
    expect(withheld[0]?.reason).toBeTruthy()
  })
})
