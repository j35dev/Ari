import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildClaudeArgs } from './claude-driver'

describe('buildClaudeArgs', () => {
  const base: AdapterSession = {
    sessionId: 'sess_1',
    workspacePath: 'D:\\proj',
    prompt: 'do the thing',
    modelId: null,
    permissionMode: 'ask',
    resumeOf: null,
  }

  it('uses bidirectional stream-json with stdio permission prompts (no -p; prompt rides stdin)', () => {
    const args = buildClaudeArgs(base)
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args.indexOf('--input-format')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(args.indexOf('--permission-prompt-tool')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio')
    expect(args).not.toContain('-p')
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
