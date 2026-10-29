import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BOT_MEMORY_MAX_CHARS, BotMemoryStore } from './bot-memory'

let dir: string
let memory: BotMemoryStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-memory-'))
  memory = new BotMemoryStore({ dir })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('adds, patches, and removes memory lines', async () => {
  expect(await memory.read('bot_a')).toBe('')
  await memory.add('bot_a', 'Prefer small commits.')
  await memory.add('bot_a', 'Run pnpm verify before reporting.')
  expect(await memory.read('bot_a')).toBe(
    'Prefer small commits.\n\nRun pnpm verify before reporting.\n',
  )
  await memory.patch('bot_a', 'small commits', 'one commit per task')
  expect(await memory.read('bot_a')).toContain('Prefer one commit per task.')
  await memory.remove('bot_a', 'Run pnpm verify before reporting.')
  expect(await memory.read('bot_a')).toBe('Prefer one commit per task.\n')
  await expect(memory.patch('bot_a', 'missing', 'x')).rejects.toThrow('does not contain')
  await expect(memory.remove('bot_a', 'missing')).rejects.toThrow('does not contain')
  await expect(memory.add('bot_a', '  ')).rejects.toThrow('empty')
})

it('refuses an edit that passes the cap and says the size', async () => {
  await expect(memory.add('bot_a', 'x'.repeat(BOT_MEMORY_MAX_CHARS + 1))).rejects.toThrow(
    `the cap is ${String(BOT_MEMORY_MAX_CHARS)}`,
  )
  await memory.add('bot_a', 'x'.repeat(BOT_MEMORY_MAX_CHARS - 1))
  await expect(memory.add('bot_a', 'one more')).rejects.toThrow(
    `${String(BOT_MEMORY_MAX_CHARS + 10)} characters`,
  )
})

it('freezes memory per session and never touches the project folder', async () => {
  await memory.add('bot_a', 'first')
  expect(await memory.snapshot('bot_a', 'sess_1')).toBe('first\n')
  await memory.add('bot_a', 'second')
  expect(await memory.snapshot('bot_a', 'sess_1')).toBe('first\n')
  expect(await memory.snapshot('bot_a', 'sess_2')).toContain('second')

  const snapshot = await readFile(join(dir, 'bot_a', 'snapshots', 'sess_1.md'), 'utf8')
  expect(snapshot).toBe('first\n')
  await expect(memory.snapshot('../escape', 'sess_1')).rejects.toThrow('unknown bot')
  await expect(memory.snapshot('bot_a', '../escape')).rejects.toThrow('unknown session')
})

it('replaces the whole memory, and clears it with nothing', async () => {
  await memory.add('bot_a', 'old note')
  expect(await memory.replace('bot_a', 'new\nnotes')).toBe('new\nnotes\n')
  expect(await memory.read('bot_a')).toBe('new\nnotes\n')
  expect(await memory.replace('bot_a', '')).toBe('')
  expect(await memory.read('bot_a')).toBe('')
  await expect(
    memory.replace('bot_a', `${'x'.repeat(BOT_MEMORY_MAX_CHARS)} extra`),
  ).rejects.toThrow(`the cap is ${String(BOT_MEMORY_MAX_CHARS)}`)
})
