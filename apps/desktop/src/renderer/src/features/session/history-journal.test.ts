import { describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import type { JournalEvent } from '@ari/contracts/events'
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
