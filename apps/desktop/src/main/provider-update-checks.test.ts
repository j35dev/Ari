// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Detection } from '@ari/providers/types'
import { nativeCheckCommand, parseNativeLatest } from './provider-update-checks'

const grok: Detection = {
  kind: 'grok',
  installed: true,
  binaryPath: 'C:/Users/u/.grok/bin/grok.exe',
  version: '1.0.92',
  authStatus: 'unknown',
}
const qoder: Detection = {
  ...grok,
  kind: 'qoder',
  binaryPath: 'C:/Users/u/.qoder/bin/qodercli.exe',
  version: '1.1.92',
}

describe('vendor update checks', () => {
  it('uses only read-only flags for native installations', () => {
    expect(nativeCheckCommand(grok)).toEqual([grok.binaryPath, 'update', '--check', '--json'])
    expect(nativeCheckCommand(qoder)).toEqual([qoder.binaryPath, 'update', '--check'])
    expect(
      nativeCheckCommand({ ...grok, binaryPath: 'C:/Users/u/AppData/Roaming/npm/grok.cmd' }),
    ).toBeNull()
    expect(nativeCheckCommand({ ...grok, kind: 'hermes' })).toBeNull()
  })

  it('reads Grok latest from its selected stable/alpha channel', () => {
    expect(
      parseNativeLatest(grok, '{"latestVersion":"1.0.93-alpha.1","channel":"alpha","error":null}'),
    ).toBe('1.0.93-alpha.1')
    expect(parseNativeLatest(grok, '{"latestVersion":null,"error":"offline"}')).toBeNull()
    expect(parseNativeLatest(grok, 'not json')).toBeNull()
  })

  it('reads Qoder check output, including a current installation', () => {
    expect(parseNativeLatest(qoder, 'Update available: 1.1.92 -> 1.1.94')).toBe('1.1.94')
    expect(parseNativeLatest(qoder, 'Already up to date.')).toBe('1.1.92')
    expect(parseNativeLatest(qoder, 'Request failed')).toBeNull()
  })
})
