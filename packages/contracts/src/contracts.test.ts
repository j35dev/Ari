import { describe, expect, it } from 'vitest'
import { agentEventSchema } from './agent-event'
import { commandSchema } from './commands'
import { journalEventSchema } from './events'
import { messagePartSchema } from './message'
import { rpcParams, SEARCH_CONTENT_MAX_RESULTS, usageSummarySchema } from './rpc'
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
    expect(settingsUpdateSchema.parse({ appearance: { themeId: 'nocturne' } })).toEqual({
      appearance: { themeId: 'nocturne' },
    })
    // Patches carry no legacy migration; only settingsSchema rewrites 'comet-glass'.
    expect(settingsUpdateSchema.safeParse({ appearance: { themeId: 'comet-glass' } }).success).toBe(false)
    expect(
      settingsUpdateSchema.parse({ window: { x: 0, y: 0, width: 100, height: 100, maximized: true } }).window
        ?.maximized,
    ).toBe(true)
    expect(settingsUpdateSchema.safeParse({ permissions: { allowlist: 'git status' } }).success).toBe(false)
    expect(settingsUpdateSchema.safeParse({ window: { x: 'a' } }).success).toBe(false)
  })

  it('validates fs.writeTextFile params and rejects malformed payloads', () => {
    const params = { path: '/proj/src/main.ts', content: 'export {}\n' }
    expect(rpcParams['fs.writeTextFile'].parse(params)).toEqual(params)
    expect(() => rpcParams['fs.writeTextFile'].parse({ path: '', content: 'hi' })).toThrow()
    expect(() => rpcParams['fs.writeTextFile'].parse({ path: '/a.txt' })).toThrow()
    expect(() => rpcParams['fs.writeTextFile'].parse({ path: '/a.txt', content: 7 })).toThrow()
  })

  it('validates git.turnDiff params and rejects unsafe checkpoint components', () => {
    const params = { path: '/repo', sessionId: 'sess_1', turnId: 'turn_2' }
    expect(rpcParams['git.turnDiff'].parse(params)).toEqual(params)
    expect(() => rpcParams['git.turnDiff'].parse({ ...params, sessionId: '../escape' })).toThrow()
    expect(() => rpcParams['git.turnDiff'].parse({ ...params, turnId: 'tu..rn' })).toThrow()
    expect(() => rpcParams['git.turnDiff'].parse({ ...params, turnId: '-lead' })).toThrow()
    expect(() => rpcParams['git.turnDiff'].parse({ ...params, sessionId: 'turn.lock' })).toThrow()
    expect(() => rpcParams['git.turnDiff'].parse({ path: '', sessionId: 's', turnId: 't' })).toThrow()
  })

  it('validates the usage.summary payload and rejects malformed rows', () => {
    const summary = usageSummarySchema.parse({
      rows: [
        {
          sessionId: 'sess_1',
          title: 'Fix bug',
          driverKind: 'claude',
          updatedAt: 10,
          inputTokens: 30,
          outputTokens: 12,
          costUsd: null,
        },
      ],
      totals: { inputTokens: 30, outputTokens: 12, costUsd: 0.02 },
    })
    expect(summary.rows[0]?.driverKind).toBe('claude')
    expect(summary.totals.costUsd).toBeCloseTo(0.02)
    expect(() =>
      usageSummarySchema.parse({ rows: [{ sessionId: 'sess_1' }], totals: { inputTokens: -1 } }),
    ).toThrow()
    expect(() =>
      usageSummarySchema.parse({
        rows: [],
        totals: { inputTokens: 0, outputTokens: 0, costUsd: 'free' },
      }),
    ).toThrow()
  })

  it('validates search.content params and rejects empty/anchorless queries', () => {
    expect(rpcParams['search.content'].parse({ path: '/proj', query: 'needle' })).toEqual({
      path: '/proj',
      query: 'needle',
    })
    expect(rpcParams['search.content'].parse({ projectId: 'proj_1', query: 'n', maxResults: 5 })).toEqual({
      projectId: 'proj_1',
      query: 'n',
      maxResults: 5,
    })
    expect(() => rpcParams['search.content'].parse({ path: '/proj', query: '' })).toThrow()
    expect(() => rpcParams['search.content'].parse({ query: 'no-root' })).toThrow()
    expect(() =>
      rpcParams['search.content'].parse({ path: '/proj', query: 'n', maxResults: SEARCH_CONTENT_MAX_RESULTS + 1 }),
    ).toThrow()
  })

  it('validates git action params and rejects empty messages/pathspecs', () => {
    expect(rpcParams['git.add'].parse({ path: '/repo', paths: ['src/a.ts'] })).toEqual({
      path: '/repo',
      paths: ['src/a.ts'],
    })
    expect(rpcParams['git.commit'].parse({ path: '/repo', message: 'Ship it' })).toEqual({
      path: '/repo',
      message: 'Ship it',
    })
    expect(rpcParams['git.push'].parse({ path: '/repo' })).toEqual({ path: '/repo' })
    expect(rpcParams['git.push'].parse({ path: '/repo', remote: 'upstream' })).toEqual({
      path: '/repo',
      remote: 'upstream',
    })
    expect(() => rpcParams['git.add'].parse({ path: '/repo' })).toThrow()
    expect(() => rpcParams['git.add'].parse({ path: '/repo', paths: [] })).toThrow()
    expect(() => rpcParams['git.add'].parse({ path: '/repo', paths: [''] })).toThrow()
    expect(() => rpcParams['git.commit'].parse({ path: '/repo' })).toThrow()
    expect(() => rpcParams['git.commit'].parse({ path: '/repo', message: '' })).toThrow()
    expect(() => rpcParams['git.push'].parse({ path: '', remote: 'origin' })).toThrow()
    expect(() => rpcParams['git.push'].parse({ path: '/repo', remote: '' })).toThrow()
  })
})
