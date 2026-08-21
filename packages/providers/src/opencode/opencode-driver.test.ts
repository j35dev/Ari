import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildOpencodeArgs } from './opencode-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildOpencodeArgs', () => {
  it('uses run with raw JSON events and thinking blocks enabled', () => {
    const args = buildOpencodeArgs(base)
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--thinking'])
    expect(args[args.length - 1]).toBe('do the thing')
  })

  it('emits no permission flags for ask/allow-edits; only full gets --auto', () => {
    expect(buildOpencodeArgs({ ...base, permissionMode: 'ask' })).not.toContain('--auto')
    expect(buildOpencodeArgs({ ...base, permissionMode: 'allow-edits' })).not.toContain('--auto')
    expect(buildOpencodeArgs({ ...base, permissionMode: 'full' })).toContain('--auto')
  })

  it('includes model when provided', () => {
    const args = buildOpencodeArgs({ ...base, modelId: 'anthropic/claude-sonnet-4-20250514' })
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('includes resume session and omits both when absent', () => {
    expect(buildOpencodeArgs({ ...base, resumeOf: 'ses_abc' })).toEqual(
      expect.arrayContaining(['--session', 'ses_abc']),
    )
    expect(buildOpencodeArgs(base)).not.toContain('--session')
    expect(buildOpencodeArgs(base)).not.toContain('--model')
  })
})
