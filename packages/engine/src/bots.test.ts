import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BotStore } from './bots'
import { SessionStore } from './session-store'

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
