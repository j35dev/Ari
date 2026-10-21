import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@ari/contracts/message'
import {
  TRANSCRIPT_CACHE_SIZE,
  transcriptStore,
  useTranscriptMessages,
  useTranscriptSelector,
  type TranscriptStore,
} from './transcript-store'

afterEach(cleanup)

let nextId = 0
const sessionId = (): string => `sess_store_${++nextId}`

function user(id: string): Message {
  return { id, sessionId: 's', turnId: null, role: 'user', parts: [], createdAt: 1 }
}

const start = (id: string) => (): Omit<Message, 'parts'> => ({
  id,
  sessionId: 's',
  turnId: null,
  role: 'assistant',
  createdAt: 2,
})

/** Streams `text` one flush per character; `frame` wraps each publish. */
function stream(
  store: TranscriptStore,
  text: string,
  frame: (publish: () => void) => void = (publish) => publish(),
): void {
  const fold = store.begin()
  fold.addUser(user('u1'))
  frame(() => store.publish())
  for (const ch of text) {
    fold.appendParts('a1', [{ type: 'text', text: ch }], start('a1'))
    frame(() => store.publish())
  }
}

describe('transcriptStore', () => {
  it('returns one store per session and keeps the most recent ones', () => {
    const first = sessionId()
    const store = transcriptStore(first)
    expect(transcriptStore(first)).toBe(store)
    for (let i = 0; i < TRANSCRIPT_CACHE_SIZE; i++) transcriptStore(sessionId())
    expect(transcriptStore(first)).not.toBe(store)
  })

  it('keeps the last snapshot readable until a new fold publishes', () => {
    const store = transcriptStore(sessionId())
    stream(store, 'hi')
    const cached = store.getSnapshot()
    expect(cached.map((m) => m.id)).toEqual(['u1', 'a1'])

    const fold = store.begin()
    expect(store.getSnapshot()).toBe(cached)
    fold.addUser(user('u1'))
    store.publish()
    expect(store.getSnapshot().map((m) => m.id)).toEqual(['u1'])
  })

  it('clears a cached list when the new fold has nothing to publish', () => {
    const store = transcriptStore(sessionId())
    stream(store, 'hi')
    store.begin()
    store.publish()
    expect(store.getSnapshot()).toEqual([])
  })

  it('ignores a writer still holding an older fold', () => {
    const store = transcriptStore(sessionId())
    const stale = store.begin()
    store.begin()
    stale.addUser(user('ghost'))
    store.publish()
    expect(store.getSnapshot()).toEqual([])
  })

  it('re-renders a selector only when its selection changes', () => {
    const store = transcriptStore(sessionId())
    let listRenders = 0
    let userRenders = 0
    function List() {
      listRenders++
      useTranscriptMessages(store)
      return null
    }
    function Users() {
      userRenders++
      useTranscriptSelector(
        store,
        (messages) => messages.filter((m) => m.role === 'user'),
        (a, b) => a.length === b.length && a.every((m, i) => m === b[i]),
      )
      return null
    }
    render(createElement('div', null, createElement(List), createElement(Users)))
    listRenders = 0
    userRenders = 0

    stream(store, 'streamed reply', (publish) => act(publish))
    // One user message landed: the prompt watcher woke once; the list per flush.
    expect(userRenders).toBe(1)
    expect(listRenders).toBe(1 + 'streamed reply'.length)
  })
})
