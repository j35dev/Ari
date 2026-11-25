import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import type { JournalEvent } from '@ari/contracts/events'
import { projectEvents } from '@ari/engine/projection'
import { HistoryJournal } from './history-journal'
import { createMessageFold } from './message-fold'
import type { TranscriptStore } from './transcript-store'

function historyFixture() {
  let messages: Message[] = []
  let fold = createMessageFold()
  const store = {
    sessionId: 'local:test',
    begin: () => {
      fold = createMessageFold()
      return fold
    },
    publish: () => {
      messages = fold.commit() ?? messages
    },
    dispose: () => {},
  } as unknown as TranscriptStore
  return {
    history: new HistoryJournal(store),
    messages: () => messages,
    text: () =>
      messages
        .flatMap((message) => message.parts)
        .map((part) => ('text' in part ? part.text : ''))
        .join(''),
  }
}
const text = (seq: number, value: string, replayFromSeq?: number): JournalEvent => ({
  type: 'assistant.parts.appended',
  sessionId: 'test',
  messageId: 'reply',
  seq,
  at: seq,
  parts: [{ type: 'text', text: value }],
  ...(replayFromSeq === undefined ? {} : { replayFromSeq }),
})

describe('compact conversation recovery', () => {
  it('does not duplicate cached live text when a compact history retry is incomplete', () => {
    const { history, text: contents } = historyFixture()
    history.add(text(1, 'First '))
    history.add(text(2, 'second '))
    history.add(text(3, 'third'))
    history.publish()
    expect(contents()).toBe('First second third')
    history.begin()
    history.add(text(2, 'First second ', 1))
    history.finish(false)
    history.publish()
    expect(contents()).toBe('First second third')
    history.dispose()
  })

  it('keeps compact history and a newer live delta exactly once after a successful retry', () => {
    const { history, text: contents } = historyFixture()
    history.add(text(1, 'First '))
    history.add(text(2, 'second'))
    history.publish()
    history.begin()
    history.add(text(2, 'First second', 1))
    history.add(text(3, ' third'))
    history.finish(true)
    history.publish()
    expect(contents()).toBe('First second third')
    history.dispose()
  })
})

describe('opening from saved messages', () => {
  const at = (seq: number) => ({ sessionId: 'test', seq, at: seq })
  const events: JournalEvent[] = [
    { ...at(0), type: 'turn.started', turnId: 't1' },
    {
      ...at(1),
      type: 'user.message.added',
      message: {
        id: 'prompt',
        sessionId: 'test',
        turnId: 't1',
        role: 'user',
        parts: [{ type: 'text', text: 'Do it' }],
        createdAt: 1,
      },
    },
    text(2, 'Working '),
    {
      ...at(3),
      type: 'assistant.parts.appended',
      messageId: 'reply',
      parts: [{ type: 'tool-call', callId: 'c1', name: 'read', argsJson: '{}' }],
    },
    {
      ...at(4),
      type: 'assistant.parts.appended',
      messageId: 'reply',
      parts: [{ type: 'tool-call', callId: 'c1', name: 'read', argsJson: '{"path":"a"}' }],
    },
    text(5, 'done.'),
    { ...at(6), type: 'turn.settled', turnId: 't1', stopReason: 'completed', errorMessage: null },
  ]
  const isText = (event: JournalEvent) =>
    event.type === 'user.message.added' || event.type === 'assistant.parts.appended'
  const replayed = () => {
    const fixture = historyFixture()
    for (const event of events) fixture.history.add(event)
    fixture.history.publish()
    return fixture
  }
  const seeded = () => {
    const fixture = historyFixture()
    fixture.history.seed(6, projectEvents(events).messages)
    for (const event of events) if (!isText(event)) fixture.history.add(event)
    fixture.history.publish()
    return fixture
  }

  it('shows the same transcript and controls as replaying every event', () => {
    const full = replayed()
    const snapshot = seeded()
    expect(snapshot.messages()).toEqual(full.messages())
    expect(snapshot.history.controls()).toEqual(full.history.controls())
    expect(snapshot.history.lastPart).toEqual(full.history.lastPart)
  })

  it('appends live text after the snapshot exactly once', () => {
    const { history, text: contents } = seeded()
    history.add(text(7, ' More.'))
    history.publish()
    expect(contents()).toBe('Do itWorking done. More.')
  })

  it('lets a full replay replace a seeded transcript without doubling it', () => {
    const { history, messages } = seeded()
    history.begin()
    for (const event of events) history.add(event)
    history.finish(true)
    history.publish()
    expect(messages()).toEqual(replayed().messages())
  })
})
