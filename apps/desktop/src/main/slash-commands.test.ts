// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@ari/contracts/slash-commands'
import { SessionStore } from '@ari/engine/session-store'
import type { AdapterSession, Driver } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { Engine } from './engine'
import { SessionCommandCache, routeSlashCommand, sessionCommands } from './slash-commands'

const entry = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: '',
  argumentHint: null,
  source: 'builtin',
  run: 'prompt-text',
  ...extra,
})

describe('routeSlashCommand', () => {
  const claude = [
    entry('compact'),
    entry('model', { run: 'unsupported', reason: "Use Ari's model picker." }),
    entry('usage', { aliases: ['cost'] }),
  ]

  it('sends a known command verbatim and leaves other text alone', () => {
    expect(routeSlashCommand('/compact keep the API notes', 'claude', claude)).toEqual({
      kind: 'verbatim',
      invocation: { name: 'compact', args: 'keep the API notes' },
    })
    expect(routeSlashCommand('/cost', 'claude', claude)).toMatchObject({ kind: 'verbatim' })
    expect(routeSlashCommand('fix /usr/bin', 'claude', claude)).toEqual({ kind: 'prompt' })
    expect(routeSlashCommand('/whatever', 'claude', claude)).toEqual({ kind: 'prompt' })
    // Ari's own command is expanded by the engine, not by the provider.
    expect(routeSlashCommand('/ari theme neon', 'claude', claude)).toEqual({ kind: 'prompt' })
  })

  it('blocks what Ari answers natively and terminal-only commands', () => {
    expect(routeSlashCommand('/model opus', 'claude', claude)).toEqual({
      kind: 'blocked',
      invocation: { name: 'model', args: 'opus' },
      message: "/model isn't available in Ari, so it was not sent. Use Ari's model picker.",
    })
    expect(routeSlashCommand('/quit', 'claude', claude)).toMatchObject({
      kind: 'blocked',
      message: "/quit only works in Claude Code's own terminal app, so Ari did not send it.",
    })
  })

  it('knows Codex’s client-side commands before any list arrived', () => {
    expect(routeSlashCommand('/diff', 'codex', null)).toMatchObject({ kind: 'blocked' })
    expect(routeSlashCommand('/goal ship it', 'codex', [entry('goal', { run: 'rpc' })])).toEqual({
      kind: 'rpc',
      invocation: { name: 'goal', args: 'ship it' },
    })
  })
})

describe('SessionCommandCache', () => {
  it('keeps a list per session and provider, and seeds the same folder', () => {
    const cache = new SessionCommandCache()
    cache.record('s1', 'claude', 'D:/Repo', [entry('compact')])
    expect(cache.get('s1', 'claude')).toEqual([entry('compact')])
    // After a provider switch the old list no longer applies.
    expect(cache.get('s1', 'codex')).toBeNull()
    // A between-turn report keeps the provider already known.
    cache.record('s1', null, null, [entry('review')])
    expect(cache.get('s1', 'claude')).toEqual([entry('review')])
    expect(cache.forScope('claude', 'd:/repo')).toEqual([entry('compact')])
    expect(cache.forScope('codex', 'd:/repo')).toBeNull()
  })

  it('answers the menu with Ari’s commands first and says when the list is pending', () => {
    const pending = sessionCommands('opencode', null, false)
    expect(pending.commands.map((c) => c.name)).toEqual(['ari theme'])
    expect(pending.complete).toBe(false)
    expect(pending.note).toContain('after its first reply')
    const known = sessionCommands('codex', [entry('goal', { run: 'rpc' })], true)
    expect(known.commands.map((c) => c.name).slice(0, 2)).toEqual(['ari theme', 'goal'])
    expect(known.commands.some((c) => c.name === 'model' && c.run === 'unsupported')).toBe(true)
  })
})

describe('engine slash command turns', () => {
  async function harness(listCommands?: Driver['listCommands']) {
    const dir = await mkdtemp(join(tmpdir(), 'ari-slash-turn-'))
    const store = new SessionStore({ storage: 'jsonl', rootDir: join(dir, 'sessions') })
    const registry = new DriverRegistry()
    const created: AdapterSession[] = []
    let settle: () => void = () => undefined
    registry.register({
      kind: 'codex',
      ...(listCommands ? { listCommands } : {}),
      create: async (session) => {
        created.push(session)
        return {
          start: () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'commands' as const,
                commands: [entry('compact', { run: 'rpc' }), entry('goal', { run: 'rpc' })],
              }
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
    await store.append('s', {
      type: 'session.created',
      session: {
        id: 's',
        projectId: 'p',
        title: 'Slash',
        driverKind: 'codex',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const send = async (text: string) => {
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      await engine.dispatch({ type: 'turn.start', sessionId: 's', text, attachments: [] })
      await settled
    }
    const close = async () => {
      await engine.quiesce('s')
      await store.closeJournal('s')
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
    return { engine, store, created, send, close }
  }

  it('answers a blocked command itself, never handing it to the provider', async () => {
    const h = await harness()
    try {
      await h.send('/model gpt-5')
      expect(h.created).toHaveLength(0)
      const model = await h.store.load('s')
      const notice = model.messages.find((message) => message.role === 'assistant')
      expect(notice?.parts).toEqual([
        {
          type: 'text',
          text: expect.stringContaining("ℹ /model isn't available in Ari"),
        },
      ])
      expect(model.lastTurn?.stopReason).toBe('completed')
    } finally {
      await h.close()
    }
  })

  it('caches the list a turn reports and marks the provider’s own methods', async () => {
    const h = await harness()
    try {
      await h.send('hello')
      expect(h.created[0]?.command).toBeUndefined()
      const listed = await h.engine.slashCommands('s')
      expect(listed.complete).toBe(true)
      expect(listed.commands.map((c) => c.name)).toEqual(
        expect.arrayContaining(['ari theme', 'compact', 'goal', 'model']),
      )
      await h.send('/goal ship the beta')
      expect(h.created[1]?.command).toEqual({ name: 'goal', args: 'ship the beta' })
      expect(h.created[1]?.prompt).toBe('/goal ship the beta')
    } finally {
      await h.close()
    }
  })

  it('lists commands through the driver before any turn, once at a time', async () => {
    let calls = 0
    const h = await harness(async () => {
      calls++
      return [entry('review', { run: 'rpc' })]
    })
    try {
      const [first, second] = await Promise.all([
        h.engine.slashCommands('s'),
        h.engine.slashCommands('s'),
      ])
      expect(calls).toBe(1)
      expect(first.commands.map((c) => c.name)).toContain('review')
      expect(second).toEqual(first)
      await h.engine.slashCommands('s')
      expect(calls).toBe(1)
    } finally {
      await h.close()
    }
  })
})
