import { describe, expect, it } from 'vitest'
import { checkedAgo, providerStatus, shortVersion } from './provider-status'
import type { Detection } from './provider-status'

const installed: Detection = {
  kind: 'claude',
  enabled: true,
  installed: true,
  binaryPath: '/usr/bin/claude',
  version: '2.1.296 (Claude Code)',
  authStatus: 'authenticated',
  pathSource: 'auto',
}

const missing: Detection = {
  kind: 'claude',
  enabled: true,
  installed: false,
  binaryPath: null,
  version: null,
  authStatus: 'unknown',
}

const status = (detection: Detection | undefined, extra: object = {}) =>
  providerStatus({ kind: 'claude', detection, enabled: true, ...extra })

describe('providerStatus', () => {
  it('reads Off from the setting, whatever detection last said', () => {
    expect(providerStatus({ kind: 'claude', detection: installed, enabled: false })).toMatchObject({
      tone: 'quiet',
      headline: 'Off',
    })
  })

  it('is checking until a detection for the current setting arrives', () => {
    expect(status(undefined)).toMatchObject({ tone: 'busy', headline: 'Checking' })
    // Just turned on: the last round still describes it as off.
    expect(status({ ...missing, enabled: false })).toMatchObject({ headline: 'Checking' })
  })

  it('separates a path that was rejected from a CLI that is simply not there', () => {
    expect(status({ ...missing, pathProblem: 'No file exists at this path.' })).toEqual({
      tone: 'error',
      headline: 'Path not usable',
      detail: 'No file exists at this path.',
    })
    expect(status(missing)).toMatchObject({ tone: 'quiet', headline: 'Not installed' })
  })

  it('believes a refused turn over a credential file', () => {
    const refused = {
      source: 'live' as const,
      result: { status: 'auth-required' as const, label: 'Claude', logins: [] },
    }
    expect(status(installed, { auth: refused })).toMatchObject({
      tone: 'warning',
      headline: 'Sign-in needed',
    })
  })

  it('warns when signed out, unless a preflight just proved otherwise', () => {
    const signedOut = { ...installed, authStatus: 'unauthenticated' }
    expect(status(signedOut)).toMatchObject({ tone: 'warning', headline: 'Not signed in' })
    const ready = { source: 'probe' as const, result: { status: 'ready' as const, label: 'Claude' } }
    expect(status(signedOut, { auth: ready })).toMatchObject({ tone: 'ok', headline: 'Ready' })
  })

  it('flags a chosen file that runs but does not look like the CLI', () => {
    expect(status({ ...installed, pathSource: 'custom', pathProblem: 'No --version.' })).toEqual({
      tone: 'warning',
      headline: 'Check the path',
      detail: 'No --version.',
    })
  })

  it('reports a running install ahead of what was detected before it', () => {
    expect(status(missing, { install: { operation: 'install', outcome: null } })).toMatchObject({
      tone: 'busy',
      headline: 'Installing',
    })
  })

  it('distinguishes ready, update available and installed-but-unverified', () => {
    expect(status(installed)).toMatchObject({ tone: 'ok', headline: 'Ready' })
    expect(status({ ...installed, updateAvailable: true, latestVersion: '2.2.0' })).toEqual({
      tone: 'update',
      headline: 'Update available',
      detail: 'Version 2.2.0',
    })
    expect(status({ ...installed, authStatus: 'unknown', authReason: 'No store.' })).toEqual({
      tone: 'ok',
      headline: 'Installed',
      detail: 'Sign-in not verified.',
    })
  })

  it('never asks Ari Core for a CLI', () => {
    expect(providerStatus({ kind: 'ari-core', detection: undefined, enabled: true })).toMatchObject({
      tone: 'quiet',
      headline: 'Built in',
    })
  })
})

describe('shortVersion', () => {
  it('pulls the number out of whatever the CLI printed', () => {
    expect(shortVersion('2.1.296 (Claude Code)')).toBe('2.1.296')
    expect(shortVersion('codex-cli 0.160.0')).toBe('0.160.0')
    expect(shortVersion('grok 1.4.0-beta.2')).toBe('1.4.0-beta.2')
    expect(shortVersion('nightly')).toBe('nightly')
    expect(shortVersion(null)).toBeNull()
  })
})

describe('checkedAgo', () => {
  it('rounds down to a unit worth reading', () => {
    const at = 1_000_000_000
    expect(checkedAgo(at, at + 20_000)).toBe('just now')
    expect(checkedAgo(at, at + 3 * 60_000 + 5_000)).toBe('3 min ago')
    expect(checkedAgo(at, at + 2 * 3_600_000 + 60_000)).toBe('2 h ago')
    expect(checkedAgo(at, at - 5_000)).toBe('just now')
  })
})
