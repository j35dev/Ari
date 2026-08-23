import { describe, expect, it } from 'vitest'
import { agentEventSchema } from './agent-event'
import { commandSchema } from './commands'
import { journalEventSchema } from './events'
import { messagePartSchema } from './message'
import { sessionSchema } from './session'
import { settingsUpdateSchema } from './settings'

const baseSession = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Fix login bug',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1_000,
  updatedAt: 1_000,
}

describe('contracts', () => {
  it('round-trips a session', () => {
    const parsed = sessionSchema.parse(baseSession)
    expect(parsed.driverKind).toBe('claude')
  })

  it('rejects unknown driver kinds and statuses', () => {
    expect(() => sessionSchema.parse({ ...baseSession, driverKind: 'skynet' })).toThrow()
    expect(() => sessionSchema.parse({ ...baseSession, status: 'quantum' })).toThrow()
  })

  it('discriminates message parts', () => {
    expect(messagePartSchema.parse({ type: 'text', text: 'hi' }).type).toBe('text')
    expect(() => messagePartSchema.parse({ type: 'vibes' })).toThrow()
  })

  it('validates every agent event variant', () => {
    const events = [
      { type: 'text-delta', text: 'he' },
      { type: 'thinking-delta', text: 'hm' },
      { type: 'tool-started', callId: 'c1', name: 'bash', argsJson: '{}' },
      { type: 'tool-completed', callId: 'c1', resultJson: '{}', isError: false },
      { type: 'approval-requested', approvalId: 'a1', toolName: 'edit_file', summaryJson: '{}' },
      { type: 'input-requested', inputId: 'q1', prompt: 'Which?', choicesJson: null },
      { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: null },
      { type: 'status', status: 'running' },
      { type: 'error', message: 'boom', rawJson: null },
      { type: 'done' },
    ] as const
    for (const event of events) {
      expect(agentEventSchema.parse(event).type).toBe(event.type)
    }
  })

  it('validates commands and defaults attachments', () => {
    const cmd = commandSchema.parse({
      type: 'turn.start',
      sessionId: 'sess_1',
      text: 'do it',
    })
    if (cmd.type === 'turn.start') expect(cmd.attachmentPaths).toEqual([])
    expect(() => commandSchema.parse({ type: 'turn.start', sessionId: 's', text: '' })).toThrow()
  })

  it('validates journal events with seq/at/session base', () => {
    const event = journalEventSchema.parse({
      type: 'turn.settled',
      seq: 3,
      at: Date.now(),
      sessionId: 'sess_1',
      turnId: 'turn_1',
      stopReason: 'completed',
    })
    expect(event.type).toBe('turn.settled')
    expect(() =>
      journalEventSchema.parse({ type: 'turn.settled', seq: -1, at: 1, sessionId: 's', turnId: 't', stopReason: 'completed' }),
    ).toThrow()
  })

  it('accepts empty and partial settings update patches, rejects bad fields', () => {
    expect(settingsUpdateSchema.parse({})).toEqual({})
    expect(settingsUpdateSchema.parse({ appearance: { themeId: 'comet-glass' } })).toEqual({
      appearance: { themeId: 'comet-glass' },
    })
    expect(
      settingsUpdateSchema.parse({ window: { x: 0, y: 0, width: 100, height: 100, maximized: true } }).window
        ?.maximized,
    ).toBe(true)
    expect(settingsUpdateSchema.safeParse({ permissions: { allowlist: 'git status' } }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ window: { x: 'a' } }).success).toBe(false)
  })
})
