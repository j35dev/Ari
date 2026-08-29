import { describe, expect, it, vi } from 'vitest'
import {
  compareSemver,
  createUpdateChecker,
  evaluateInstallSettle,
  parseVersionToken,
} from './updates'
import type { FetchLike ,
  NPM_PACKAGES} from './updates'
import type { Detection } from './types'

function jsonFetcher(body: unknown): FetchLike {
  return (async () => new Response(JSON.stringify(body), { status: 200 }))
}

const detection = (kind: keyof typeof NPM_PACKAGES | 'grok', version: string | null): Detection => ({
  kind: kind,
  installed: true,
  binaryPath: `/usr/bin/${kind}`,
  version,
  authStatus: 'authenticated',
})

/** noUncheckedIndexedAccess guard for single-element enrich results. */
function first(detections: Detection[]): Detection {
  const value = detections[0]
  if (value === undefined) throw new Error('expected one detection')
  return value
}

describe('parseVersionToken', () => {
  it('extracts the first dotted token from noisy --version output', () => {
    expect(parseVersionToken('2.1.9 (Claude Code)')).toBe('2.1.9')
    expect(parseVersionToken('codex-cli 0.42.13')).toBe('0.42.13')
    expect(parseVersionToken('v3.0.1')).toBe('3.0.1')
    // Build metadata is dropped — it never affects semver ordering.
    expect(parseVersionToken('1.2.3-beta.7+build')).toBe('1.2.3-beta.7')
  })

  it('returns null for unparseable or missing output', () => {
    expect(parseVersionToken(null)).toBeNull()
    expect(parseVersionToken('unknown')).toBeNull()
    expect(parseVersionToken('')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('orders major/minor/patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('2.1.0', '2.0.9')).toBe(1)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('handles differing segment counts and prereleases', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0)
    expect(compareSemver('1.2.3-rc.1', '1.2.3')).toBe(-1)
    expect(compareSemver('1.2.4-rc.1', '1.2.3')).toBe(1)
  })
})

describe('createUpdateChecker', () => {
  it('flags stale installs with the registry latest version', async () => {
    const checker = createUpdateChecker({ fetchImpl: jsonFetcher({ version: '9.9.9' }) })
    const enriched = first(await checker.enrich([detection('claude', '2.1.9 (Claude Code)')]))
    expect(enriched.latestVersion).toBe('9.9.9')
    expect(enriched.updateAvailable).toBe(true)
  })

  it('reports up-to-date installs as false', async () => {
    const checker = createUpdateChecker({ fetchImpl: jsonFetcher({ version: '2.1.9' }) })
    const enriched = first(await checker.enrich([detection('claude', '2.1.9 (Claude Code)')]))
    expect(enriched.updateAvailable).toBe(false)
  })

  it('leaves kinds without an npm package untouched', async () => {
    const fetchImpl = vi.fn()
    const checker = createUpdateChecker({ fetchImpl: fetchImpl as never })
    const enriched = first(await checker.enrich([detection('grok', '1.0.5')]))
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(enriched.latestVersion).toBeUndefined()
    expect(enriched.updateAvailable).toBeUndefined()
  })

  it('fails soft when the registry is unreachable', async () => {
    const fetcher = (async () => {
      throw new Error('offline')
    }) as never
    const checker = createUpdateChecker({ fetchImpl: fetcher })
    const enriched = first(await checker.enrich([detection('codex', '0.42.0')]))
    expect(enriched.latestVersion).toBeNull()
    expect(enriched.updateAvailable).toBeNull()
  })

  it('caches answers within the ttl so repeated rounds do not re-fetch', async () => {
    const fetchImpl = vi.fn(jsonFetcher({ version: '3.0.0' }))
    const checker = createUpdateChecker({ fetchImpl: fetchImpl })
    await checker.enrich([detection('opencode', '1.0.0')])
    await checker.enrich([detection('opencode', '1.0.0')])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('skips detections without a binary', async () => {
    const fetchImpl = vi.fn()
    const checker = createUpdateChecker({ fetchImpl: fetchImpl as never })
    const enriched = first(
      await checker.enrich([
        { kind: 'claude', installed: false, binaryPath: null, version: null, authStatus: 'unknown' },
      ]),
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(enriched.updateAvailable).toBeUndefined()
  })
})

describe('evaluateInstallSettle', () => {
  const installed = { installed: true, version: '1.0.0' }
  const missing = { installed: false, version: null }

  it('rejects a non-zero exit even when the binary is still present', () => {
    expect(
      evaluateInstallSettle({
        operation: 'upgrade',
        exitCode: 1,
        failure: null,
        before: installed,
        after: installed,
      }),
    ).toEqual({ ok: false, reason: 'Exited with code 1.' })
  })

  it('rejects an install that finished without a detectable binary', () => {
    expect(
      evaluateInstallSettle({
        operation: 'install',
        exitCode: 0,
        failure: null,
        before: missing,
        after: missing,
      }),
    ).toEqual({ ok: false, reason: 'The CLI is still not detected after the command finished.' })
  })

  it('accepts an install once the CLI is resolvable', () => {
    expect(
      evaluateInstallSettle({
        operation: 'install',
        exitCode: 0,
        failure: null,
        before: missing,
        after: installed,
      }),
    ).toEqual({ ok: true, reason: null })
  })

  it('accepts an upgrade that reaches the registry latest', () => {
    expect(
      evaluateInstallSettle({
        operation: 'upgrade',
        exitCode: 0,
        failure: null,
        before: { installed: true, version: '1.0.0' },
        after: { installed: true, version: '2.0.0', latestVersion: '2.0.0' },
      }),
    ).toEqual({ ok: true, reason: null })
  })

  it('rejects an upgrade that exits 0 but leaves the same version (skipped scripts)', () => {
    expect(
      evaluateInstallSettle({
        operation: 'upgrade',
        exitCode: 0,
        failure: null,
        before: { installed: true, version: '1.0.0' },
        after: { installed: true, version: '1.0.0', latestVersion: '2.0.0' },
      }).ok,
    ).toBe(false)
  })
})
