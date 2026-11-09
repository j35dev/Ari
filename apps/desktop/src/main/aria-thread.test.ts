import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { defaultSettings } from '@ari/contracts/settings'
import { AriaThread, type AriaThreadDeps } from './aria-thread'

let rows: SessionSummary[]
let deps: AriaThreadDeps
let aria: AriaThread

beforeEach(() => {
  rows = []
  deps = {
    listSessions: async () => rows,
    loadProject: vi.fn(async () => undefined),
    createSession: vi.fn(async (session) => {
      rows.push({ ...session, messageCount: 0 })
    }),
    archive: vi.fn(async (id) => {
      rows = rows.map((row) => (row.id === id ? { ...row, archived: true } : row))
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
  it('creates once across concurrent opens and windows, then reuses the current topic', async () => {
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

  it('uses Settings Aria before the renderer pick or the provider fallback', async () => {
    deps.settings = async () => ({
      ...defaultSettings,
      aria: { driverKind: 'claude', modelId: 'opus', effort: 'high', permissionMode: 'full' },
    })
    await aria.open({ driverKind: 'codex', modelId: null, permissionMode: 'ask' })
    expect(rows[0]).toMatchObject({
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'high',
      permissionMode: 'full',
    })
    expect(deps.defaults).not.toHaveBeenCalled()
  })

  it('uses the app new-session provider and model when Aria is unset', async () => {
    await aria.open({
      driverKind: 'claude',
      modelId: 'sonnet',
      permissionMode: 'full',
      effort: 'medium',
    })
    expect(rows[0]).toMatchObject({
      driverKind: 'claude',
      modelId: 'sonnet',
      permissionMode: 'ask',
      effort: 'medium',
    })
  })

  it('archives the current topic before creating a fresh one', async () => {
    const first = await aria.open()
    const next = await aria.newTopic()
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(deps.archive).toHaveBeenCalledWith(first.sessionId)
    expect(rows.find((row) => row.id === first.sessionId)?.archived).toBe(true)
    expect(await aria.open()).toEqual(next)
  })

  it('lists only past Aria topics, newest first', async () => {
    rows = [
      { id: 'older', projectId: 'helm', title: 'Legacy topic', updatedAt: 1, messageCount: 1 },
      { id: 'current', projectId: 'helm', title: 'Current', updatedAt: 4, messageCount: 1 },
      {
        id: 'other',
        projectId: 'project',
        title: 'Archived project session',
        updatedAt: 5,
        messageCount: 1,
        archived: true,
      },
      {
        id: 'newer',
        projectId: 'helm',
        title: 'Recent topic',
        updatedAt: 3,
        messageCount: 1,
        archived: true,
      },
    ]
    expect((await aria.topics()).map((row) => row.id)).toEqual(['newer', 'older'])
  })

  it('preserves the topic when archiving is refused', async () => {
    const first = await aria.open()
    deps.archive = vi.fn(async () => {
      throw new Error('busy')
    })
    await expect(aria.newTopic()).rejects.toThrow('busy')
    expect(await aria.open()).toEqual(first)
    expect(deps.createSession).toHaveBeenCalledOnce()
  })
})
