// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import type { Session } from '@ari/contracts/session'
import { SessionStore } from '@ari/engine/session-store'
import { SessionNotifier, sessionNotice, type SessionNotice } from './session-notifier'

const event = (fields: Record<string, unknown>): JournalEvent =>
  ({ seq: 1, at: 1, sessionId: 'root', ...fields }) as JournalEvent
const settled = (stopReason: string, errorMessage: string | null = null): JournalEvent =>
  event({ type: 'turn.settled', turnId: 't', stopReason, errorMessage })
const root = { title: 'Ship settings', isChild: false, liveChildren: 0 }

describe('sessionNotice', () => {
  it('announces a finished turn only when the work is finished', () => {
    expect(sessionNotice(settled('completed'), root)).toEqual({
      title: 'Ship settings finished',
      body: 'The turn is complete.',
    })
    expect(sessionNotice(settled('completed'), { ...root, liveChildren: 2 })).toBeNull()
    expect(sessionNotice(settled('completed'), { ...root, isChild: true })).toBeNull()
    expect(sessionNotice(settled('interrupted'), root)).toBeNull()
  })

  it('always reports a failure or a session waiting on the user, child or not', () => {
    const child = { ...root, title: 'Parser', isChild: true }
    expect(sessionNotice(settled('error', 'rate\n limited'), child)).toEqual({
      title: 'Parser failed',
      body: 'rate limited',
    })
    expect(
      sessionNotice(
        event({ type: 'approval.requested', approvalId: 'a', toolName: 'Bash', summaryJson: '{}' }),
        child,
      ),
    ).toEqual({ title: 'Parser needs your approval', body: 'Bash' })
    const question = sessionNotice(
      event({ type: 'input.requested', inputId: 'i', prompt: 'x'.repeat(400), choicesJson: null }),
      root,
    )
    expect(question?.title).toBe('Ship settings has a question')
    expect(question?.body).toHaveLength(180)
    expect(sessionNotice(event({ type: 'turn.started', turnId: 't' }), root)).toBeNull()
  })
})

describe('SessionNotifier', () => {
  let dir: string
  let store: SessionStore
  let shown: { sessionId: string; notice: SessionNotice }[]
  let enabled: boolean
  let focused: boolean
  let notifier: SessionNotifier

  const session = (id: string, parentSessionId?: string): Session => ({
    id,
    projectId: 'p',
    title: id === 'root' ? 'Ship settings' : 'Parser',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
    status: 'idle',
    ...(parentSessionId ? { parentSessionId, rootSessionId: 'root' } : {}),
    createdAt: 1,
    updatedAt: 1,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ari-notifier-'))
    store = new SessionStore({ rootDir: dir })
    await store.append('root', { type: 'session.created', session: session('root') })
    await store.append('child', { type: 'session.created', session: session('child', 'root') })
    shown = []
    enabled = true
    focused = false
    notifier = new SessionNotifier({
      store,
      enabled: () => enabled,
      focused: () => focused,
      show: (sessionId, notice) => shown.push({ sessionId, notice }),
    })
  })
  afterEach(async () => {
    for (const row of await store.listSessions()) await store.closeJournal(row.id)
    await rm(dir, { recursive: true, force: true })
  })

  it('stays quiet while Ari is focused or the setting is off', async () => {
    focused = true
    notifier.observe('root', settled('completed'))
    focused = false
    enabled = false
    notifier.observe('root', settled('completed'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shown).toEqual([])
  })

  it('holds the finished notice while a child is still working, then sends it', async () => {
    await store.append('child', { type: 'turn.started', turnId: 'c1' })
    notifier.observe('root', settled('completed'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shown).toEqual([])

    await store.append('child', {
      type: 'turn.settled',
      turnId: 'c1',
      stopReason: 'completed',
      errorMessage: null,
    })
    notifier.observe('root', settled('completed'))
    await expect.poll(() => shown).toEqual([
      { sessionId: 'root', notice: { title: 'Ship settings finished', body: 'The turn is complete.' } },
    ])
  })
})
