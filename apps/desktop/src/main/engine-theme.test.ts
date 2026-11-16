// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'

it('expands a theme command for the agent while preserving the original user message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-theme-turn-'))
  const store = new SessionStore({ rootDir: join(dir, 'sessions') })
  const registry = new DriverRegistry()
  let providerPrompt = ''
  let settle!: () => void
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  registry.register({
    kind: 'claude',
    create: async (session) => {
      providerPrompt = session.prompt
      return {
        start: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'done' as const }
          },
        }),
        interrupt: () => undefined,
        dispose: async () => undefined,
      }
    },
  })
  const engine = new Engine({
    store,
    registry,
    resolveWorkspace: async () => dir,
    publish: (_id, event) => {
      if (event.type === 'turn.settled') settle()
    },
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  try {
    await store.append('theme', {
      type: 'session.created',
      session: {
        id: 'theme',
        projectId: 'p',
        title: 'Theme',
        driverKind: 'claude',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const text = '/ari theme neon cyan with sharp corners'
    await engine.dispatch({ type: 'turn.start', sessionId: 'theme', text, attachments: [] })
    await settled
    expect(providerPrompt).toContain('ari theme schema --json')
    expect(providerPrompt).toContain('neon cyan with sharp corners')
    const messages = (await store.load('theme')).messages.filter(
      (message) => message.role === 'user',
    )
    expect(messages[0]?.parts).toEqual([{ type: 'text', text }])
  } finally {
    await engine.quiesce('theme')
    await store.closeJournal('theme')
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})
