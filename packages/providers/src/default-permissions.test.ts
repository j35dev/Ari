import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { AdapterSession } from './driver'
import { pickAgentMode } from './acp/modes'
import { buildClaudeArgs } from './claude/claude-driver'
import { buildCodexArgs, threadOptions } from './codex/codex-driver'
import { buildGrokArgs } from './grok/grok-driver'
import { buildHermesArgs } from './hermes/hermes-driver'
import { buildOpencodeArgs } from './opencode/opencode-driver'
import { buildPiArgs } from './pi/pi-driver'

const session: AdapterSession = {
  sessionId: 'new-session',
  workspacePath: '/project',
  prompt: 'Run the project checks',
  modelId: null,
  permissionMode: defaultSettings.sessions.defaultPermissionMode,
  resumeOf: null,
}

describe('default permissions across provider harnesses', () => {
  it.each([
    ['Claude', buildClaudeArgs],
    ['Grok', buildGrokArgs],
    ['Hermes', buildHermesArgs],
  ] as const)('launches %s with bypass permissions', (_name, buildArgs) => {
    expect(buildArgs(session)).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
    )
  })

  it('launches Codex with an unrestricted sandbox and no approval prompts', () => {
    expect(buildCodexArgs(session)).toEqual(
      expect.arrayContaining(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']),
    )
    expect(threadOptions(session.permissionMode)).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
  })

  it('launches legacy OpenCode with automatic tool approvals', () => {
    expect(buildOpencodeArgs(session)).toContain('--auto')
  })

  it('launches pi with all tools available', () => {
    const args = buildPiArgs(session)
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--exclude-tools')
  })

  it.each([
    ['Claude', ['auto', 'default', 'acceptEdits', 'bypassPermissions'], 'bypassPermissions'],
    ['Codex', ['chat', 'yolo'], 'yolo'],
    ['OpenCode', ['plan', 'build'], 'build'],
  ] as const)('selects the native full-access mode for %s over ACP', (_name, modes, expected) => {
    expect(pickAgentMode([...modes], session.permissionMode)).toBe(expected)
  })
})
