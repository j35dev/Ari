import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTool } from '../tools'
import { TODO_FILENAME, formatChecklist, todoFilenameFor, todoWriteTool } from './todo'

describe('todo_write tool', () => {
  it('is registered as a built-in tool', () => {
    expect(findTool('todo_write')).toBe(todoWriteTool)
  })

  it('persists JSON at a fixed workspace-relative path and returns a checklist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    try {
      const result = await todoWriteTool.execute(
        {
          items: [
            { text: 'implement parser', status: 'done' },
            { text: 'write tests', status: 'in_progress' },
            { text: 'ship it', status: 'pending' },
          ],
        },
        { workspacePath: dir },
      )
      expect(result).toContain('1. [x] implement parser')
      expect(result).toContain('2. [~] write tests')
      expect(result).toContain('3. [ ] ship it')

      const raw = await readFile(join(dir, TODO_FILENAME), 'utf8')
      expect(JSON.parse(raw)).toEqual([
        { text: 'implement parser', status: 'done' },
        { text: 'write tests', status: 'in_progress' },
        { text: 'ship it', status: 'pending' },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('roundtrips through read with the same content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    try {
      const items = [{ text: 'only step', status: 'pending' }]
      await todoWriteTool.execute({ items }, { workspacePath: dir })
      const reader = findTool('read')
      expect(reader).toBeDefined()
      const content = await reader?.execute({ path: TODO_FILENAME }, { workspacePath: dir })
      expect(JSON.parse(content ?? '')).toEqual(items)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cannot escape the workspace even with hostile item text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    const parent = await mkdtemp(join(tmpdir(), 'ari-todo-out-'))
    try {
      await todoWriteTool.execute(
        {
          items: [
            { text: `../../${parent}/evil.txt`, status: 'pending' },
            { text: 'normal step', status: 'done' },
          ],
        },
        { workspacePath: dir },
      )
      const entries = await readdir(dir)
      expect(entries).toEqual([TODO_FILENAME])
      const outside = await readdir(parent)
      expect(outside).toEqual([])
      const raw = await readFile(join(dir, TODO_FILENAME), 'utf8')
      const saved = JSON.parse(raw) as { text: string }[]
      expect(saved[0]?.text).toBe(`../../${parent}/evil.txt`)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects malformed items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    try {
      await expect(
        todoWriteTool.execute({ items: [{ text: 'x', status: 'cancelled' }] }, { workspacePath: dir }),
      ).rejects.toThrow(/invalid status/)
      await expect(
        todoWriteTool.execute({ items: [{ status: 'done' }] }, { workspacePath: dir }),
      ).rejects.toThrow(/non-empty text/)
      await expect(todoWriteTool.execute({}, { workspacePath: dir })).rejects.toThrow(
        /items must be an array/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('formats an empty list', () => {
    expect(formatChecklist([])).toBe('(empty todo list)')
  })

  it('scopes the filename per session, keeping the legacy shared file without one', () => {
    expect(todoFilenameFor()).toBe(TODO_FILENAME)
    expect(todoFilenameFor(null)).toBe(TODO_FILENAME)
    expect(todoFilenameFor('ses_123')).toBe('.ari-todo-ses_123.json')
    expect(todoFilenameFor('../../evil')).toBe('.ari-todo-.._.._evil.json')
  })

  it('isolates sibling sessions sharing one workspace folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    try {
      await todoWriteTool.execute(
        { items: [{ text: 'session A step', status: 'done' }] },
        { workspacePath: dir, sessionId: 'session-a' },
      )
      await todoWriteTool.execute(
        { items: [{ text: 'session B step', status: 'pending' }] },
        { workspacePath: dir, sessionId: 'session-b' },
      )
      const rawA = await readFile(join(dir, todoFilenameFor('session-a')), 'utf8')
      const rawB = await readFile(join(dir, todoFilenameFor('session-b')), 'utf8')
      expect(JSON.parse(rawA)).toEqual([{ text: 'session A step', status: 'done' }])
      expect(JSON.parse(rawB)).toEqual([{ text: 'session B step', status: 'pending' }])
      const entries = await readdir(dir)
      expect(entries).not.toContain(TODO_FILENAME)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a hostile session id inside the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-todo-'))
    const parent = await mkdtemp(join(tmpdir(), 'ari-todo-out-'))
    try {
      await todoWriteTool.execute(
        { items: [{ text: 'evil step', status: 'pending' }] },
        { workspacePath: dir, sessionId: '../../evil' },
      )
      const entries = await readdir(dir)
      expect(entries).toEqual([todoFilenameFor('../../evil')])
      expect(await readdir(parent)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  })
})
