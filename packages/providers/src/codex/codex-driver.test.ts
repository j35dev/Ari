import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { buildCodexArgs } from './codex-driver'

const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'do the thing',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

describe('buildCodexArgs', () => {
  it('uses exec --json with repo check skipped', () => {
    const args = buildCodexArgs(base)
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args[args.length - 1]).toBe('do the thing')
  })

  it('maps permission modes to sandbox/approval flags', () => {
    expect(buildCodexArgs({ ...base, permissionMode: 'ask' })).toEqual(
      expect.arrayContaining(['--ask-for-approval', 'on-request']),
    )
    expect(buildCodexArgs({ ...base, permissionMode: 'allow-edits' })).toEqual(
      expect.arrayContaining(['--sandbox', 'workspace-write']),
    )
    expect(buildCodexArgs({ ...base, permissionMode: 'full' })).toEqual(
      expect.arrayContaining(['--sandbox', 'danger-full-access']),
    )
  })

  it('includes model when provided', () => {
    const args = buildCodexArgs({ ...base, modelId: 'gpt-5.2-codex' })
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.2-codex')
  })
})
