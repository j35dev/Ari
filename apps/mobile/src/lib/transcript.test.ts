import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import {
  applyEvents,
  delivered,
  fromSnapshot,
  prependPage,
  type StreamedEvent,
  type TranscriptSnapshot,
} from './transcript'

function message(id: string, role: Message['role'], text: string): Message {
  return { id, sessionId: 's', turnId: null, role, parts: [{ type: 'text', text }], createdAt: 1 }
}
function snapshot(fields: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
  return {
    session: {
      id: 's',
      projectId: 'p',
      title: 'Session',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
    summary: {
      id: 's',
      projectId: 'p',
      title: 'Session',
      updatedAt: 1,
      messageCount: 2,
      status: 'idle',
    },
    seq: 10,
    messages: [message('u1', 'user', 'Hi'), message('a1', 'assistant', 'Hello')],
    pendingApprovals: [],
    pendingInputs: [],
    ...fields,
  }
}
const event = (seq: number, body: Record<string, unknown>): StreamedEvent => ({
  seq,
  event: { seq, at: 50, sessionId: 's', ...body },
})

describe('the phone transcript', () => {
  it('streams a reply into the message it belongs to without touching the others', () => {
    const start = fromSnapshot(snapshot(), null)
    const { transcript, reconcile } = applyEvents(start, [
      event(11, { type: 'session.status.changed', from: 'idle', to: 'running', reason: null }),
      event(12, { type: 'user.message.added', message: message('u2', 'user', 'More') }),
      event(13, {
        type: 'assistant.parts.appended',
        messageId: 'a2',
        parts: [{ type: 'text', text: 'Wor', streamId: 'x' }],
      }),
      event(14, {
        type: 'assistant.parts.appended',
        messageId: 'a2',
        parts: [{ type: 'text', text: 'king', streamId: 'x' }],
      }),
    ])
    expect(reconcile).toBe('none')
    expect(transcript.seq).toBe(14)
    expect(transcript.session.status).toBe('running')
    expect(transcript.summary.live).toBe(true)
    expect(transcript.messages.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(transcript.messages[3]?.parts).toEqual([
      { type: 'text', text: 'Working', streamId: 'x' },
    ])
    // Earlier messages keep their identity, so only the streaming one re-renders.
    expect(transcript.messages[0]).toBe(start.messages[0])
    expect(transcript.messages[1]).toBe(start.messages[1])
  })

  it('ignores what it already has and asks for a read when the stream skips ahead', () => {
    const start = fromSnapshot(snapshot(), null)
    const repeat = applyEvents(start, [
      event(9, { type: 'user.message.added', message: message('old', 'user', 'x') }),
    ])
    expect(repeat.transcript.messages).toHaveLength(2)
    expect(repeat.reconcile).toBe('none')
    const gap = applyEvents(start, [event(15, { type: 'turn.started', turnId: 't' })])
    expect(gap.reconcile).toBe('now')
  })

  it('opens and closes approvals and questions as they stream', () => {
    const start = fromSnapshot(snapshot(), null)
    const asked = applyEvents(start, [
      event(11, {
        type: 'approval.requested',
        approvalId: 'ap',
        toolName: 'Bash',
        summaryJson: '{}',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      }),
      event(12, { type: 'input.requested', inputId: 'in', prompt: 'Which?', choicesJson: null }),
    ]).transcript
    expect(asked.pendingApprovals.map((entry) => entry.approvalId)).toEqual(['ap'])
    expect(asked.pendingInputs.map((entry) => entry.inputId)).toEqual(['in'])
    const answered = applyEvents(asked, [
      event(13, { type: 'approval.responded', approvalId: 'ap', optionId: 'allow' }),
      event(14, { type: 'input.responded', inputId: 'in', value: 'this' }),
    ]).transcript
    expect(answered.pendingApprovals).toEqual([])
    expect(answered.pendingInputs).toEqual([])
  })

  it('asks for a read after events only the desktop can describe', () => {
    const start = fromSnapshot(snapshot(), null)
    expect(
      applyEvents(start, [event(11, { type: 'child.session.spawned', childSessionId: 'c' })])
        .reconcile,
    ).toBe('soon')
    expect(
      applyEvents(start, [
        event(11, { type: 'turn.settled', turnId: 't', stopReason: 'completed' }),
      ]).reconcile,
    ).toBe('soon')
    expect(
      applyEvents(start, [
        event(11, {
          type: 'assistant.parts.appended',
          messageId: 'a1',
          parts: [],
          replayFromSeq: 3,
        }),
      ]).reconcile,
    ).toBe('now')
  })

  it('re-applies streamed events that are newer than a read that raced them', () => {
    const start = fromSnapshot(snapshot(), null)
    const streamed = [
      event(11, { type: 'user.message.added', message: message('u2', 'user', 'Raced') }),
    ]
    const live = applyEvents(start, streamed).transcript
    // The read was taken before event 11 reached the desktop's projection.
    const merged = fromSnapshot(snapshot({ seq: 10 }), live, streamed)
    expect(merged.seq).toBe(11)
    expect(merged.messages.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('keeps pages scrolled back to across a reconcile of the newest page', () => {
    const newest = fromSnapshot(
      snapshot({
        messages: [message('m3', 'user', 'c'), message('m4', 'assistant', 'd')],
        earlier: 2,
      }),
      null,
    )
    expect(newest.earlier).toBe(2)
    const older = prependPage(newest, {
      messages: [message('m1', 'user', 'a'), message('m2', 'assistant', 'b')],
      earlier: 0,
    })
    expect(older.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(older.earlier).toBe(0)
    const reconciled = fromSnapshot(
      snapshot({
        messages: [message('m3', 'user', 'c'), message('m4', 'assistant', 'd')],
        earlier: 2,
      }),
      older,
    )
    expect(reconciled.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(reconciled.earlier).toBe(0)
    expect(reconciled.messages[0]).toBe(older.messages[0])
  })

  it('applies renames, model and mode changes to the session it shows', () => {
    const start = fromSnapshot(snapshot(), null)
    const { transcript } = applyEvents(start, [
      event(11, {
        type: 'session.updated',
        title: 'Renamed',
        modelId: 'opus',
        permissionMode: 'auto',
        archived: true,
      }),
    ])
    expect(transcript.session).toMatchObject({
      title: 'Renamed',
      modelId: 'opus',
      permissionMode: 'auto',
      archived: true,
    })
    expect(transcript.summary.title).toBe('Renamed')
  })

  it('knows when the conversation shows a message the phone sent', () => {
    const messages = [message('u1', 'user', 'Ship it'), message('a1', 'assistant', 'ok')]
    expect(delivered(messages, ' Ship it ', 0)).toBe(true)
    // Only messages that arrived after it was sent count.
    expect(delivered(messages, 'Ship it', 1)).toBe(false)
    expect(delivered(messages, 'Something else', 0)).toBe(false)
  })
})
