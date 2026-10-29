import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { BotStore } from './bots'
import { SessionStore } from './session-store'

const crashOn = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  const patched = {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, data] = args
      const crash = crashOn.value
      if (crash !== null && typeof path === 'string' && typeof data === 'string') {
        if (basename(path).startsWith(crash)) {
          await actual.writeFile(path, data.slice(0, Math.floor(data.length / 2)), 'utf8')
          throw new Error('write crashed')
        }
      }
      return actual.writeFile(...args)
    },
  }
  return { ...patched, default: patched }
})

let userData: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'ari-bots-'))
})

afterEach(async () => {
  await rm(userData, { recursive: true, force: true, maxRetries: 3 })
})

it('keeps bots and the session botId across a restart', async () => {
  const bot = await new BotStore({ dir: join(userData, 'bots') }).create({
    name: 'Forge',
    emoji: '🔨',
    personaMd: '# Forge\n\nSenior engineer.\n',
    driverKind: 'claude',
    modelId: 'opus',
    projectId: 'proj_1',
  })
  const sessions = new SessionStore({ rootDir: join(userData, 'sessions') })
  await sessions.append('sess_1', {
    type: 'session.created',
    session: {
      id: 'sess_1',
      projectId: 'proj_1',
      title: 'Hive',
      driverKind: 'claude',
      modelId: 'opus',
      permissionMode: 'ask',
      status: 'idle',
      botId: bot.id,
      createdAt: 1,
      updatedAt: 1,
    },
  })
  await sessions.closeJournal('sess_1')

  const restarted = new BotStore({ dir: join(userData, 'bots') })
  expect(await restarted.get(bot.id)).toEqual(bot)
  expect(await restarted.list()).toEqual([bot])
  const reloaded = new SessionStore({ rootDir: join(userData, 'sessions') })
  expect((await reloaded.load('sess_1')).session?.botId).toBe(bot.id)
  await reloaded.closeJournal('sess_1')
})

it('keeps the persona in its own markdown file beside the record', async () => {
  const dir = join(userData, 'bots')
  const bot = await new BotStore({ dir }).create({
    name: 'Pixel',
    emoji: '🎨',
    personaMd: '# Pixel\n',
    driverKind: 'codex',
    modelId: null,
  })

  expect(await readdir(join(dir, bot.id))).toEqual(['bot.json', 'persona.md'])
  expect(await readFile(join(dir, bot.id, 'persona.md'), 'utf8')).toBe('# Pixel\n')
  expect(await readFile(join(dir, bot.id, 'bot.json'), 'utf8')).not.toContain('# Pixel')
})

it('lists nothing before any bot exists and resolves no id outside its folder', async () => {
  const store = new BotStore({ dir: join(userData, 'bots') })
  expect(await store.list()).toEqual([])
  expect(await store.get('../sessions')).toBeNull()
  expect(await store.get('bot_missing')).toBeNull()
})

it('updates a bot and keeps the change across a new store', async () => {
  const dir = join(userData, 'bots')
  const store = new BotStore({ dir })
  const bot = await store.create({
    name: 'Forge',
    emoji: '🔨',
    personaMd: '# Forge\n',
    driverKind: 'claude',
    modelId: null,
  })

  const updated = await store.update(bot.id, { hidden: true, personaMd: '# New\n' })

  expect(updated).toEqual({ ...bot, hidden: true, personaMd: '# New\n' })
  expect(await new BotStore({ dir }).get(bot.id)).toEqual(updated)
  expect(await readFile(join(dir, bot.id, 'persona.md'), 'utf8')).toContain('# New\n')
  expect(await readdir(join(dir, bot.id))).toEqual(['bot.json', 'persona.md'])
})

it('keeps a bot character, title and tagline through create and update', async () => {
  const dir = join(userData, 'bots')
  const store = new BotStore({ dir })
  const bot = await store.create({
    name: 'Forge',
    emoji: '🔨',
    character: {
      body: 'round',
      eyes: 'visor',
      mouth: 'grin',
      top: 'antenna',
      accessory: 'headset',
      palette: 3,
    },
    title: 'Builder',
    tagline: 'Ships it.',
    personaMd: '# Forge\n',
    driverKind: 'claude',
    modelId: null,
  })
  expect(await new BotStore({ dir }).get(bot.id)).toEqual(bot)
  expect(bot).toMatchObject({ title: 'Builder', tagline: 'Ships it.', character: { palette: 3 } })

  const updated = await store.update(bot.id, {
    character: { ...bot.character!, top: 'halo', palette: 9 },
    title: 'Lead builder',
  })

  expect(await new BotStore({ dir }).get(bot.id)).toEqual(updated)
  expect(updated).toMatchObject({
    title: 'Lead builder',
    tagline: 'Ships it.',
    character: { top: 'halo', palette: 9 },
  })
})

it('loads a bot saved before characters, titles and taglines', async () => {
  const dir = join(userData, 'bots')
  await mkdir(join(dir, 'bot_old'), { recursive: true })
  await writeFile(
    join(dir, 'bot_old', 'bot.json'),
    JSON.stringify({
      id: 'bot_old',
      name: 'Old',
      emoji: '🦉',
      driverKind: 'claude',
      modelId: null,
    }),
    'utf8',
  )
  await writeFile(join(dir, 'bot_old', 'persona.md'), '# Old\n', 'utf8')

  const bot = await new BotStore({ dir }).get('bot_old')

  expect(bot).toEqual({
    id: 'bot_old',
    name: 'Old',
    emoji: '🦉',
    personaMd: '# Old\n',
    driverKind: 'claude',
    modelId: null,
  })
  expect(bot && ['character', 'title', 'tagline'].filter((key) => key in bot)).toEqual([])
})

it('refuses to update an unknown bot', async () => {
  const store = new BotStore({ dir: join(userData, 'bots') })
  await expect(store.update('bot_missing', { hidden: true })).rejects.toThrow('unknown bot')
})

it('never writes an id other than its folder', async () => {
  const dir = join(userData, 'bots')
  const store = new BotStore({ dir })
  const bot = await store.create({
    name: 'Forge',
    emoji: '🔨',
    personaMd: '# Forge\n',
    driverKind: 'claude',
    modelId: null,
  })

  const updated = await store.update(bot.id, { id: 'bot_other' } as never)

  expect(updated.id).toBe(bot.id)
  const record = JSON.parse(await readFile(join(dir, bot.id, 'bot.json'), 'utf8')) as Bot
  expect(record.id).toBe(bot.id)
})

it('treats a bot.json naming another id as corrupt', async () => {
  const dir = join(userData, 'bots')
  const store = new BotStore({ dir })
  const bot = await store.create({
    name: 'Forge',
    emoji: '🔨',
    personaMd: '# Forge\n',
    driverKind: 'claude',
    modelId: null,
  })
  const path = join(dir, bot.id, 'bot.json')
  const record = JSON.parse(await readFile(path, 'utf8')) as Bot
  await writeFile(path, JSON.stringify({ ...record, id: 'bot_other' }), 'utf8')

  expect(await store.get(bot.id)).toBeNull()
  expect(await store.list()).toEqual([])
  await expect(store.update(bot.id, { hidden: true })).rejects.toThrow('unknown bot')
})

it('keeps the last good record when a write crashes', async () => {
  const dir = join(userData, 'bots')
  const store = new BotStore({ dir })
  const bot = await store.create({
    name: 'Forge',
    emoji: '🔨',
    personaMd: '# Forge\n',
    driverKind: 'claude',
    modelId: null,
  })

  crashOn.value = 'bot.json'
  await expect(store.update(bot.id, { name: 'Renamed' })).rejects.toThrow('write crashed')
  crashOn.value = null

  expect(await new BotStore({ dir }).get(bot.id)).toEqual(bot)
  expect(await new BotStore({ dir }).list()).toEqual([bot])

  const crashed = join(dir, 'bot_crashed')
  await mkdir(crashed, { recursive: true })
  await writeFile(
    join(crashed, 'bot.json.00000000-0000-0000-0000-000000000000.tmp'),
    JSON.stringify({
      id: 'bot_crashed',
      name: 'Crashed',
      emoji: '💥',
      driverKind: 'claude',
      modelId: null,
    }),
    'utf8',
  )
  expect(await new BotStore({ dir }).list()).toEqual([bot])
})
