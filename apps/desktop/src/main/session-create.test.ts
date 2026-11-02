import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { createSession, type SessionCreateDeps } from './session-create'

let dir: string
let sessions: SessionStore
let created: string[]
let deps: SessionCreateDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-desktop-session-create-'))
  sessions = new SessionStore({ rootDir: join(dir, 'sessions') })
  created = []
  deps = {
    loadProject: async (id) => {
      if (id !== 'proj_1') throw new Error('no project')
    },
    createSession: (session) => {
      created.push(session.id)
      return sessions.append(session.id, { type: 'session.created', session }).then(() => undefined)
    },
  }
})

afterEach(async () => {
  for (const id of created.splice(0)) await sessions.closeJournal(id)
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

it('creates a session in a known project', async () => {
  const { sessionId } = await createSession(deps, {
    projectId: 'proj_1',
    title: 't',
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
  })

  const { session } = await sessions.load(sessionId)
  expect(session?.projectId).toBe('proj_1')
  expect(session?.title).toBe('t')
})

it('refuses a session for an unknown project before writing it', async () => {
  await expect(
    createSession(deps, {
      projectId: 'proj_x',
      title: 't',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
    }),
  ).rejects.toThrow('no project')
  expect(await sessions.listSessions()).toEqual([])
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
