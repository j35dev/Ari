import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileConversationStore,
  MemoryConversationStore,
  type ConversationStore,
} from './conversation-store'

const MESSAGES = [
  { role: 'user' as const, content: 'first prompt' },
  { role: 'assistant' as const, content: 'first answer' },
]

function contract(name: string, make: () => Promise<{ store: ConversationStore; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    it('round-trips a conversation per session', async () => {
      const { store, cleanup } = await make()
      try {
        expect(await store.load('s1')).toEqual([])
        await store.save('s1', MESSAGES)
        expect(await store.load('s1')).toEqual(MESSAGES)
        // Sessions are isolated from each other.
        expect(await store.load('s2')).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('replaces the stored conversation on save', async () => {
      const { store, cleanup } = await make()
      try {
        await store.save('s1', MESSAGES)
        await store.save('s1', [{ role: 'user', content: 'only this' }])
        expect(await store.load('s1')).toEqual([{ role: 'user', content: 'only this' }])
      } finally {
        await cleanup()
      }
    })

    it('clears a session', async () => {
      const { store, cleanup } = await make()
      try {
        await store.save('s1', MESSAGES)
        await store.clear('s1')
        expect(await store.load('s1')).toEqual([])
      } finally {
        await cleanup()
      }
    })

    it('does not hand out its own arrays', async () => {
      const { store, cleanup } = await make()
      try {
        const saved = [...MESSAGES]
        await store.save('s1', saved)
        const loaded = await store.load('s1')
        loaded.push({ role: 'user', content: 'mutation' })
        expect(await store.load('s1')).toHaveLength(MESSAGES.length)
      } finally {
        await cleanup()
      }
    })
  })
}

contract('MemoryConversationStore', () =>
  Promise.resolve({ store: new MemoryConversationStore(), cleanup: () => Promise.resolve() }),
)

contract('FileConversationStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-conv-'))
  return {
    store: new FileConversationStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
})

describe('FileConversationStore resilience', () => {
  it('treats a corrupt file as an empty conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-conv-bad-'))
    try {
      await writeFile(join(dir, 's1.json'), '{not json', 'utf8')
      expect(await new FileConversationStore(dir).load('s1')).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops rows that are not chat messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-conv-junk-'))
    try {
      await writeFile(
        join(dir, 's1.json'),
        JSON.stringify([{ role: 'user', content: 'keep' }, 42, { role: 'nope', content: 'x' }]),
        'utf8',
      )
      expect(await new FileConversationStore(dir).load('s1')).toEqual([
        { role: 'user', content: 'keep' },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a path-like session id inside its directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-conv-path-'))
    try {
      const store = new FileConversationStore(dir)
      await store.save('../escape', MESSAGES)
      expect(await store.load('../escape')).toEqual(MESSAGES)
      const { readdir } = await import('node:fs/promises')
      // Separators are replaced, so the traversal lands in the directory as a
      // plain filename instead of escaping it.
      expect(await readdir(dir)).toEqual(['.._escape.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
