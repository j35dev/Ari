import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { BotStore } from '@ari/engine/bots'
import { SessionStore } from '@ari/engine/session-store'
import { createBot, createSession, updateBot, type SessionCreateDeps } from './bots'

let dir: string
let bots: BotStore
let sessions: SessionStore
let created: string[]
let deps: SessionCreateDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-desktop-bots-'))
  bots = new BotStore({ dir: join(dir, 'bots') })
  sessions = new SessionStore({ rootDir: join(dir, 'sessions') })
  created = []
  deps = {
    bots,
    loadProject: async (id) => {
      if (id !== 'proj_1') throw new Error('no project')
    },
    createSession: (session) => {
      created.push(session.id)
      return sessions.append(session.id, { type: 'session.created', session }).then(() => undefined)
    },
    defaultPermissionMode: () => 'ask',
  }
})

afterEach(async () => {
  for (const id of created.splice(0)) await sessions.closeJournal(id)
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

const botInput = {
  name: 'Forge',
  emoji: '🔨',
  personaMd: '# Forge\n',
  driverKind: 'claude' as const,
  modelId: null,
  projectId: 'proj_1',
}

it('creates a session bound to a known bot', async () => {
  const bot = await bots.create(botInput)
  const { sessionId } = await createSession(deps, {
    projectId: 'proj_1',
    title: 't',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    botId: bot.id,
  })

  const { session } = await sessions.load(sessionId)
  expect(session?.botId).toBe(bot.id)
})

it('refuses a session for an unknown bot', async () => {
  await expect(
    createSession(deps, {
      projectId: 'proj_1',
      title: 't',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      botId: 'bot_missing',
    }),
  ).rejects.toThrow('unknown bot: bot_missing')
  expect(await sessions.listSessions()).toEqual([])
})

it('creates a session without a bot as before', async () => {
  const { sessionId } = await createSession(deps, {
    projectId: 'proj_1',
    title: 't',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
  })

  const { session } = await sessions.load(sessionId)
  expect(session && Object.prototype.hasOwnProperty.call(session, 'botId')).toBe(false)
})

it('creates a lead session that says so, and only when asked', async () => {
  const lead = await createSession(deps, {
    projectId: 'proj_1',
    title: 'Lead',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    lead: true,
  })
  expect((await sessions.load(lead.sessionId)).session?.lead).toBe(true)

  const plain = await createSession(deps, {
    projectId: 'proj_1',
    title: 'Plain',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
  })
  const { session } = await sessions.load(plain.sessionId)
  expect(session && Object.prototype.hasOwnProperty.call(session, 'lead')).toBe(false)
})

it('creates a bot whose main session runs as that bot', async () => {
  const bot = await createBot(deps, botInput)

  expect(bot.mainSessionId).toBeDefined()
  const { session } = await sessions.load(bot.mainSessionId!)
  expect(session?.botId).toBe(bot.id)
  expect(session?.title).toBe(bot.name)
  expect(session?.projectId).toBe('proj_1')
  expect((await new BotStore({ dir: join(dir, 'bots') }).get(bot.id))?.mainSessionId).toBe(
    bot.mainSessionId,
  )
})

it('leaves the bot without a main session when the session cannot be created', async () => {
  const failing: SessionCreateDeps = {
    ...deps,
    createSession: async () => {
      throw new Error('boom')
    },
  }

  await expect(createBot(failing, botInput)).rejects.toThrow('boom')
  const all = await bots.list()
  expect(all).toHaveLength(1)
  expect(all[0]?.mainSessionId).toBeUndefined()
})

it('refuses a bot for an unknown project before writing it', async () => {
  await expect(createBot(deps, { ...botInput, projectId: 'proj_x' })).rejects.toThrow('no project')
  expect(await bots.list()).toEqual([])
})

it('hides and unhides a bot', async () => {
  const bot = await bots.create(botInput)

  await bots.update(bot.id, { hidden: true })
  expect((await new BotStore({ dir: join(dir, 'bots') }).get(bot.id))?.hidden).toBe(true)

  await bots.update(bot.id, { hidden: false })
  expect((await new BotStore({ dir: join(dir, 'bots') }).get(bot.id))?.hidden).toBe(false)
})

it('updates a bot, writes its persona to its own file, and refreshes its rooms', async () => {
  const bot = await bots.create(botInput)
  const refreshed: Bot[] = []
  const character = {
    body: 'tall',
    eyes: 'wide',
    mouth: 'smile',
    top: 'horns',
    accessory: 'monocle',
    palette: 4,
  } as const

  const updated = await updateBot(
    { bots, refreshRooms: async (next) => void refreshed.push(next) },
    bot.id,
    { name: '  Anvil ', character, title: 'Smith', tagline: 'Hot iron.', personaMd: '# Anvil\n' },
  )

  expect(updated).toEqual({
    ...bot,
    name: 'Anvil',
    character,
    title: 'Smith',
    tagline: 'Hot iron.',
    personaMd: '# Anvil\n',
  })
  expect(await new BotStore({ dir: join(dir, 'bots') }).get(bot.id)).toEqual(updated)
  expect(await readFile(join(dir, 'bots', bot.id, 'persona.md'), 'utf8')).toBe('# Anvil\n')
  expect(await readFile(join(dir, 'bots', bot.id, 'bot.json'), 'utf8')).not.toContain('# Anvil')
  expect(refreshed).toEqual([updated])
})

it('refuses an update for an unknown bot or to a blank name', async () => {
  const bot = await bots.create(botInput)
  const refreshRooms = vi.fn(async () => undefined)

  await expect(updateBot({ bots, refreshRooms }, 'bot_missing', { title: 'x' })).rejects.toThrow(
    'unknown bot: bot_missing',
  )
  await expect(updateBot({ bots, refreshRooms }, bot.id, { name: '   ' })).rejects.toThrow(
    'bot name is empty',
  )
  expect(await bots.get(bot.id)).toEqual(bot)
  expect(refreshRooms).not.toHaveBeenCalled()
})

it('keeps a saved edit when its rooms cannot be refreshed, and logs it', async () => {
  const bot = await bots.create(botInput)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const updated = await updateBot(
      {
        bots,
        refreshRooms: async () => {
          throw new Error('disk full')
        },
      },
      bot.id,
      { emoji: '⚒️' },
    )
    expect(updated.emoji).toBe('⚒️')
    expect((await bots.get(bot.id))?.emoji).toBe('⚒️')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('team rooms did not pick up a bot edit'),
      expect.objectContaining({ botId: bot.id, error: 'Error: disk full' }),
    )
  } finally {
    warn.mockRestore()
  }
})
