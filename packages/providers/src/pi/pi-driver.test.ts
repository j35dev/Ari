import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildPiArgs } from './pi-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildPiArgs', () => {
  it('uses json print mode and persists the session for follow-ups', () => {
    const args = buildPiArgs(base)
    expect(args.slice(0, 2)).toEqual(['--mode', 'json'])
    expect(args).not.toContain('--no-session')
    expect(args[args.length - 1]).toBe('-p')
    expect(args).not.toContain(base.prompt)
  })

  it('maps permission modes to tool capability flags', () => {
    expect(buildPiArgs({ ...base, permissionMode: 'ask' })).toEqual(
      expect.arrayContaining(['--tools', 'read,grep,find,ls']),
    )
    expect(buildPiArgs({ ...base, permissionMode: 'allow-edits' })).toEqual(
      expect.arrayContaining(['--exclude-tools', 'bash']),
    )
    expect(buildPiArgs({ ...base, permissionMode: 'full' })).not.toContain('--tools')
    expect(buildPiArgs({ ...base, permissionMode: 'full' })).not.toContain('--exclude-tools')
  })

  it('includes model when provided', () => {
    const args = buildPiArgs({ ...base, modelId: 'anthropic/claude-haiku-4-5' })
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-haiku-4-5')
  })

  it('preserves a reasoning selection on fresh and resumed native turns', () => {
    for (const resumeOf of [null, 'thread']) {
      const args = buildPiArgs({ ...base, effort: 'xhigh', resumeOf })
      expect(args[args.indexOf('--thinking') + 1]).toBe('xhigh')
    }
  })

  it('resumes via --session when resumeOf is set', () => {
    const args = buildPiArgs({ ...base, resumeOf: '01a0231d-d596' })
    expect(args[args.indexOf('--session') + 1]).toBe('01a0231d-d596')
  })
})
