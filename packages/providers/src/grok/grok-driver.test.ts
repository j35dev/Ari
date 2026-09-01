import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildGrokArgs } from './grok-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildGrokArgs', () => {
  it('uses single-turn headless mode with streaming messages json', () => {
    const args = buildGrokArgs(base)
    expect(args.slice(0, 2)).toEqual(['-p', 'do the thing'])
    expect(args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'streaming-messages-json',
        '--include-partial-messages',
      ]),
    )
  })

  it('maps permission modes to grok permission-mode flags', () => {
    expect(buildGrokArgs({ ...base, permissionMode: 'ask' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'default']),
    )
    expect(buildGrokArgs({ ...base, permissionMode: 'allow-edits' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'acceptEdits']),
    )
    expect(buildGrokArgs({ ...base, permissionMode: 'full' })).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    )
  })

  it('includes model when provided', () => {
    const args = buildGrokArgs({ ...base, modelId: 'grok-4.6' })
    expect(args[args.indexOf('--model') + 1]).toBe('grok-4.6')
  })

  it('passes reasoning effort when the session picked one', () => {
    const args = buildGrokArgs({ ...base, effort: 'xhigh' })
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh')
  })

  it('omits model and resume when absent', () => {
    const args = buildGrokArgs(base)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--resume')
  })

  it('resumes a prior grok session when resumeOf is set', () => {
    const args = buildGrokArgs({ ...base, resumeOf: '01a0231c-4a83-7483-bd01-79d0a0d7d3e4' })
    expect(args[args.indexOf('--resume') + 1]).toBe('01a0231c-4a83-7483-bd01-79d0a0d7d3e4')
  })
})
