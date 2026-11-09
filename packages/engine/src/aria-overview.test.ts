import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { ariaOverview } from './aria-overview'
import { initialReadModel, type SessionReadModel } from './projection'
import type { HelmView } from './helm'

const NOW = 48 * 3_600_000
const DAY = 24 * 3_600_000

function model(
  id: string,
  overrides: Partial<SessionReadModel> = {},
  session: Partial<Session> = {},
): SessionReadModel {
  return {
    ...initialReadModel(),
    session: {
      id,
      projectId: 'web',
      title: id,
      driverKind: 'codex',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      ...session,
    },
    ...overrides,
  }
}

function view(models: SessionReadModel[]) {
  return {
    rows: models.map(({ session }) => ({
      ...session,
      id: session!.id,
      projectId: session!.projectId,
      title: session!.title,
      updatedAt: session!.updatedAt,
      status: 'idle',
      archived: session!.archived ?? false,
      pinned: false,
      messageCount: 1,
      lastMessagePreview: null,
    })),
    load: vi.fn(async (id) => models.find((model) => model.session?.id === id)!),
    projectName: (id) => (id === 'web' ? 'Website' : null),
  } satisfies HelmView
}

function message(
  id: string,
  turnId: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt = 10,
) {
  return { id, sessionId: id, turnId, role, createdAt, parts: [{ type: 'text' as const, text }] }
}

describe('ariaOverview', () => {
  it('lists every pending decision newest first, with a title or tool fallback and one-line question', async () => {
    const old = model(
      'old',
      {
        activeTurnId: 't',
        pendingApprovals: [
          {
            approvalId: 'a1',
            toolName: 'shell',
            summaryJson: '{"title":"  Run build  \\nDetails"}',
            options: [],
          },
          { approvalId: 'a2', toolName: 'write_file', summaryJson: 'invalid', options: [] },
          { approvalId: 'a3', toolName: 'read_file', summaryJson: 'null', options: [] },
        ],
      },
      { updatedAt: 30 },
    )
    const newer = model(
      'new',
      {
        activeTurnId: 't',
        pendingInputs: [
          { inputId: 'q', prompt: '  Which region?\nMore context', choicesJson: null },
        ],
      },
      { updatedAt: 40 },
    )
    const source = view([old, newer])
    const result = await ariaOverview(source, model('aria', {}, { projectId: 'helm' }), NOW)
    expect(result.needsYou.map((row) => [row.sessionId, row.kind, row.summary])).toEqual([
      ['new', 'question', 'Which region?'],
      ['old', 'approval', 'read_file'],
      ['old', 'approval', 'write_file'],
      ['old', 'approval', 'Run build'],
    ])
    expect(result.running).toEqual([])
    expect(result.needsYou[0]?.projectName).toBe('Website')
    expect(source.load).toHaveBeenCalledTimes(2)
    expect(old.pendingApprovals[0]?.approvalId).toBe('a1')
  })

  it('uses journal state and turn start, and attributes only sessions created by an Aria topic', async () => {
    const aria = model('aria', {}, { projectId: 'helm' })
    const past = model('past', {}, { projectId: 'helm', archived: true })
    const working = model(
      'working',
      {
        activeTurnId: 't',
        messages: [
          message('ask', 't', 'user', 'Build it', 100),
          message('reply', 't', 'assistant', 'Working', 200),
        ],
      },
      { createdBy: { kind: 'session', sessionId: 'past' } },
    )
    const queued = model(
      'queued',
      { queuedMessages: [{ text: 'Next', attachments: [] }] },
      { updatedAt: 300 },
    )
    const other = model(
      'other',
      { activeTurnId: 't' },
      { createdBy: { kind: 'session', sessionId: 'working' } },
    )
    const child = model(
      'child',
      { activeTurnId: 't' },
      { parentSessionId: 'working', createdBy: { kind: 'session', sessionId: 'aria' } },
    )
    const result = await ariaOverview(view([aria, past, working, queued, other, child]), aria, NOW)
    expect(result.running.map((row) => row.sessionId)).toEqual([
      'queued',
      'working',
      'other',
      'child',
    ])
    expect(result.running[0]).toMatchObject({
      state: 'queued',
      startedAt: null,
      startedByAria: false,
    })
    expect(result.running[1]).toMatchObject({
      state: 'working',
      startedAt: 100,
      startedByAria: true,
    })
    expect(result.running.slice(2).every((row) => !row.startedByAria)).toBe(true)
  })

  it('uses reported turns and settle times in the last 24 hours, excluding archived and Aria sessions', async () => {
    const aria = model(
      'aria',
      {
        childCompletions: {
          done: { turnId: 'reported', acknowledged: true, settledAt: NOW - 20 },
          running: { turnId: 'reported', acknowledged: false, settledAt: NOW - 10 },
          old: { turnId: 't', acknowledged: true, settledAt: NOW - DAY },
          future: { turnId: 't', acknowledged: false, settledAt: NOW + 1 },
          missingTime: { turnId: 't', acknowledged: true },
          archived: { turnId: 't', acknowledged: true, settledAt: NOW },
          aria: { turnId: 't', acknowledged: true, settledAt: NOW },
          missing: { turnId: 't', acknowledged: true, settledAt: NOW },
        },
      },
      { projectId: 'helm' },
    )
    const done = model('done', {
      messages: [
        message('report', 'reported', 'assistant', '  Fixed the redirect.  \nTests pass.'),
        message('newer', 'new', 'assistant', 'Unrelated later reply'),
      ],
    })
    const running = model('running', {
      activeTurnId: 'next',
      messages: [message('report', 'reported', 'assistant', 'First report')],
    })
    const source = view([
      aria,
      done,
      running,
      model('old'),
      model('future'),
      model('missingTime'),
      model('archived', {}, { archived: true }),
    ])
    const result = await ariaOverview(source, aria, NOW)
    expect(result.doneToday.map((row) => [row.sessionId, row.report, row.settledAt])).toEqual([
      ['running', 'First report', NOW - 10],
      ['done', 'Fixed the redirect.', NOW - 20],
    ])
    expect(source.load).not.toHaveBeenCalledWith('aria')
    expect(source.load).not.toHaveBeenCalledWith('archived')
  })

  it('caps each list at 20 and reports the full overflow count', async () => {
    const needs = Array.from({ length: 23 }, (_, i) =>
      model(`needs-${i}`, {
        activeTurnId: 't',
        pendingInputs: [{ inputId: 'q', prompt: 'Question', choicesJson: null }],
      }),
    )
    const running = Array.from({ length: 22 }, (_, i) => model(`run-${i}`, { activeTurnId: 't' }))
    const done = Array.from({ length: 21 }, (_, i) => model(`done-${i}`))
    const aria = model(
      'aria',
      {
        childCompletions: Object.fromEntries(
          done.map((model) => [
            model.session!.id,
            { turnId: 't', acknowledged: true, settledAt: NOW - 1 },
          ]),
        ),
      },
      { projectId: 'helm' },
    )
    const result = await ariaOverview(view([...needs, ...running, ...done]), aria, NOW)
    expect([result.needsYou.length, result.running.length, result.doneToday.length]).toEqual([
      20, 20, 20,
    ])
    expect(result.more).toEqual({ needsYou: 3, running: 2, doneToday: 1 })
  })
})
