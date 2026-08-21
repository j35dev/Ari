import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildHermesArgs } from './hermes-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildHermesArgs', () => {
  it('uses stream-json output and verbose for parsing', () => {
    const args = buildHermesArgs(base)
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('do the thing')
  })

  it('maps permission modes to hermes flags', () => {
    expect(buildHermesArgs({ ...base, permissionMode: 'ask' })).toContain('default')
    expect(buildHermesArgs({ ...base, permissionMode: 'allow-edits' })).toContain('acceptEdits')
    expect(buildHermesArgs({ ...base, permissionMode: 'full' })).toContain('bypassPermissions')
  })

  it('includes model and resume when provided', () => {
    const args = buildHermesArgs({
      ...base,
      modelId: 'hermes-4-70b',
      resumeOf: 'abc-session',
    })
    expect(args.indexOf('--model')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--model') + 1]).toBe('hermes-4-70b')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-session')
  })

  it('omits model/resume when absent', () => {
    const args = buildHermesArgs(base)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--resume')
  })
})
