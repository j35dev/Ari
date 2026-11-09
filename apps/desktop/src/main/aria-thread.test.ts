import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { Session } from '@ari/contracts/session'
import { defaultSettings } from '@ari/contracts/settings'
import { AriaThread, type AriaThreadDeps } from './aria-thread'

let rows: SessionSummary[]
let saved: Map<string, Session>
let deps: AriaThreadDeps
let aria: AriaThread

beforeEach(() => {
  rows = []
  saved = new Map()
  deps = {
    listSessions: async () => rows,
    loadSession: vi.fn(async (id) => saved.get(id) ?? null),
    loadProject: vi.fn(async () => undefined),
    createSession: vi.fn(async (session) => {
      saved.set(session.id, session)
      rows.push({ ...session, messageCount: 0 })
    }),
    destroySession: vi.fn(async (id) => {
      saved.delete(id)
      rows = rows.filter((row) => row.id !== id)
    }),
    settings: async () => defaultSettings,
    defaults: vi.fn<AriaThreadDeps['defaults']>(async () => ({
      driverKind: 'codex',
      modelId: 'gpt-6',
      permissionMode: 'full',
      effort: 'high',
    })),
  }
  aria = new AriaThread(deps)
})

describe('AriaThread', () => {
  it('creates once across concurrent opens and windows, then reuses the current chat', async () => {
    const [first, second] = await Promise.all([aria.open(), new AriaThread(deps).open()])
    expect(first).toEqual(second)
    expect(await aria.open()).toEqual(first)
    expect(deps.createSession).toHaveBeenCalledOnce()
    expect(rows[0]).toMatchObject({
      projectId: 'helm',
      title: 'New session',
      driverKind: 'codex',
      modelId: 'gpt-6',
      effort: 'high',
      permissionMode: 'ask',
    })
  })

  it('uses the app new-session provider and model with the app default permission', async () => {
    deps.settings = async () => ({
      ...defaultSettings,
      sessions: { defaultDriverKind: null, defaultPermissionMode: 'allow-edits' },
    })
    await aria.open({
      driverKind: 'claude',
      modelId: 'sonnet',
      permissionMode: 'full',
      effort: 'medium',
    })
    expect(rows[0]).toMatchObject({
      driverKind: 'claude',
      modelId: 'sonnet',
      permissionMode: 'allow-edits',
      effort: 'medium',
    })
    expect(deps.defaults).not.toHaveBeenCalled()
  })

  it('deletes the current chat before creating a fresh one with its composer choices', async () => {
    const first = await aria.open()
    saved.set(first.sessionId, {
      ...saved.get(first.sessionId)!,
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'medium',
      permissionMode: 'full',
    })
    deps.createSession = vi.fn(async (session) => {
      expect(saved.has(first.sessionId)).toBe(false)
      saved.set(session.id, session)
      rows.push({ ...session, messageCount: 0 })
    })
    const next = await aria.newChat()
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(deps.destroySession).toHaveBeenCalledWith(first.sessionId)
    expect(rows).toHaveLength(1)
    expect(saved.get(next.sessionId)).toMatchObject({
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'medium',
      permissionMode: 'full',
    })
    expect(await aria.open()).toEqual(next)
  })

  it('serializes a reset and another window opening into one fresh chat', async () => {
    const first = await aria.open()
    const [next, opened] = await Promise.all([aria.newChat(), new AriaThread(deps).open()])
    expect(opened).toEqual(next)
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(rows).toHaveLength(1)
  })

  it('creates from app defaults when there is no chat to replace', async () => {
    const next = await aria.newChat()
    expect(deps.destroySession).not.toHaveBeenCalled()
    expect(saved.get(next.sessionId)).toMatchObject({ driverKind: 'codex', permissionMode: 'ask' })
  })

  it('preserves the chat when deletion is refused', async () => {
    const first = await aria.open()
    deps.destroySession = vi.fn(async () => {
      throw new Error('busy')
    })
    await expect(aria.newChat()).rejects.toThrow('busy')
    expect(await aria.open()).toEqual(first)
    expect(deps.createSession).toHaveBeenCalledOnce()
  })

  it('does not delete a chat whose composer choices could not be loaded', async () => {
    await aria.open()
    deps.loadSession = vi.fn(async () => null)
    await expect(aria.newChat()).rejects.toThrow('Could not load')
    expect(deps.destroySession).not.toHaveBeenCalled()
    expect(deps.createSession).toHaveBeenCalledOnce()
  })
})
