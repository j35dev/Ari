import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { Session } from '@ari/contracts/session'
import type { Command } from '@ari/contracts/commands'
import { initialReadModel, applyEvent, type SessionReadModel } from '@ari/engine/projection'
import { decideCommand, previewDispatch } from '@ari/engine/dispatcher'
import { defaultSettings } from '@ari/contracts/settings'
import { AriaThread, type AriaThreadDeps } from './aria-thread'
import { RpcRegistry } from './rpc-registry'
import { sendToAria } from './aria-widget/handoff'

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
    settings: async () => ({ ...defaultSettings, experimental: { ariaEnabled: true } }),
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
  it('refuses disabled opens and resets while retaining the same saved chat on enable', async () => {
    const current = await aria.open()
    deps.settings = async () => defaultSettings
    await expect(aria.open()).rejects.toThrow('Aria is off')
    await expect(aria.newChat()).rejects.toThrow('Aria is off')
    expect(deps.destroySession).not.toHaveBeenCalled()
    deps.settings = async () => ({ ...defaultSettings, experimental: { ariaEnabled: true } })
    expect(await aria.open()).toEqual(current)
    expect(deps.createSession).toHaveBeenCalledOnce()
  })
  it('validates no-params widget dictation through the real RPC registry and reuses app defaults', async () => {
    deps.settings = async () => ({
      ...defaultSettings,
      experimental: { ariaEnabled: true },
      sessions: { defaultDriverKind: 'codex', defaultPermissionMode: 'allow-edits' },
    })
    const registry = new RpcRegistry({ send: vi.fn() })
    const models = new Map<string, SessionReadModel>()
    const dispatch = vi.fn((command: Command) => {
      if (command.type !== 'message.enqueue') throw new Error('Widget must enqueue')
      const session = saved.get(command.sessionId)!
      const model =
        models.get(session.id) ??
        applyEvent(initialReadModel(), {
          type: 'session.created',
          seq: 0,
          at: 0,
          sessionId: session.id,
          session,
        })
      const decision = decideCommand(model, command, { turnId: 'turn_1', messageId: 'message_1' })
      models.set(session.id, previewDispatch(model, decision))
      return {
        accepted: decision.accepted,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }
    })
    registry.register('aria.open', (params) => aria.open(params))
    registry.register('command.dispatch', ({ command }) => dispatch(command))
    const handoff = {
      current: () => true,
      open: async () => (await registry.invoke('aria.open', undefined)) as { sessionId: string },
      dispatch: async (command: Command) =>
        (await registry.invoke('command.dispatch', { command })) as { accepted: boolean },
    }
    await sendToAria(handoff, 'Fix the build')
    await sendToAria(handoff, 'Run the tests')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      driverKind: 'codex',
      modelId: 'gpt-6',
      permissionMode: 'allow-edits',
    })
    expect(deps.defaults).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.enqueue', text: 'Fix the build' }),
    )
    expect(models.get(rows[0]!.id)).toMatchObject({ activeTurnId: 'turn_1' })
    expect(models.get(rows[0]!.id)?.queuedMessages).toHaveLength(1)
    await expect(registry.invoke('aria.open', {})).rejects.toThrow('invalid params for aria.open')
  })
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
      permissionMode: 'full',
    })
  })

  it('uses the app new-session provider and model with the app default permission', async () => {
    deps.settings = async () => ({
      ...defaultSettings,
      experimental: { ariaEnabled: true },
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
    expect(saved.get(next.sessionId)).toMatchObject({ driverKind: 'codex', permissionMode: 'full' })
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
