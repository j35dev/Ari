import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildClaudeArgs } from './claude-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildClaudeArgs', () => {
  it('uses stream-json output and verbose for parsing', () => {
    const args = buildClaudeArgs(base)
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('do the thing')
  })

  it('maps permission modes to claude flags', () => {
    expect(buildClaudeArgs({ ...base, permissionMode: 'ask' })).toContain('default')
    expect(buildClaudeArgs({ ...base, permissionMode: 'allow-edits' })).toContain('acceptEdits')
    expect(buildClaudeArgs({ ...base, permissionMode: 'full' })).toContain('bypassPermissions')
  })

  it('includes model and resume when provided', () => {
    const args = buildClaudeArgs({
      ...base,
      modelId: 'claude-sonnet-4-5',
      resumeOf: 'abc-session',
    })
    expect(args.indexOf('--model')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-session')
  })

  it('omits model/resume when absent', () => {
    const args = buildClaudeArgs(base)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--resume')
  })
})
