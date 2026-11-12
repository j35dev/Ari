// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { JournalEvent } from '@ari/contracts/events'
import { remoteDesktopFrameSchema, remoteOperationSchema, remoteProjectCatalogSchema, remoteHostResourcesSchema } from '@ari/contracts/remote'
import { SessionStore } from '@ari/engine/session-store'
import { Journal } from '@ari/engine/journal'
import { DriverRegistry } from '@ari/providers/registry'
import { PairingService } from '@ari/remote-gateway/pairing'
import { createRemoteGateway, type RemoteGateway } from '@ari/remote-gateway/gateway'
import { deviceKey } from '../../../../packages/remote-gateway/src/testing/device-key'
import { RawWebSocket } from '../../../../packages/remote-gateway/src/testing/ws-client'
import { Engine } from './engine'
import { createRemoteHost, type RemoteHostDeps } from './remote-host'
import { normalizeRepositoryRemote, repositoryIdentityFromRemotes } from './remote-host-metadata'
import { remotePathIsSafe } from './remote-files'

let root: string
let store: SessionStore
let engine: Engine
const gateways: RemoteGateway[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-desktop-wire-'))
  store = new SessionStore({ rootDir: join(root, 'sessions') })
  engine = new Engine({ store, registry: new DriverRegistry(), publish: () => undefined,
    resolveWorkspace: async () => root, git: { captureCheckpoint: async () => ({ ok: true, value: null }) } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const gateway of gateways.splice(0)) await gateway.close()
  await engine.shutdown()
  for (const session of await store.listSessions()) await store.closeJournal(session.id)
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
})
const fixture = (id = 's'): Session => ({ id, projectId: 'p', title: id, driverKind: 'codex', modelId: 'fixture',
  permissionMode: 'full', status: 'idle', createdAt: 1, updatedAt: 1 })
const resources = { status: 'available' as const, sampledAt: 1, cpuUtilization: 0.25, cpuCount: 4,
  availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 8 * 1024 ** 3, reason: null }
const version = { ariVersion: 'fixture', protocolVersion: 1, hostingMode: 'desktop' as const,
  update: { supported: false as const, reason: 'Manual only.', availableVersion: null, stagedVersion: null, guidance: 'Update Ari on this machine.' } }
function makeHost(overrides: Partial<RemoteHostDeps> = {}) {
  return createRemoteHost({ engine, store, driverKinds: ['codex'], defaultPermissionMode: () => 'full',
    defaultDriverKind: () => 'codex', hasProject: async (id) => id === 'p',
    listProjects: async () => [{ id: 'p', name: 'Project' }],
    listModels: async () => [{ driverKind: 'codex', available: true, defaultModelId: 'fixture', models: [{ id: 'fixture', label: 'Fixture' }], efforts: [{ id: 'high', label: 'High' }] }],
    pairing: new PairingService(), mintSessionId: () => 'new', ...overrides })
}
async function start(host = makeHost()) {
  const gateway = await createRemoteGateway({ host, port: 0, allowedOrigins: ['http://127.0.0.1:5173'] })
  gateways.push(gateway)
  return gateway
}
async function call(gateway: RemoteGateway, path: string, body: unknown, token?: string) {
  const response = await fetch(gateway.origin + path, { method: 'POST', headers: { 'content-type': 'application/json',
    origin: 'http://127.0.0.1:5173', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: { code: string } } }
}
async function pair(gateway: RemoteGateway, projects = ['p']) {
  const key = deviceKey()
  const invitation = gateway.pairing.begin(gateway.origin)
  const requested = await call(gateway, '/pair/request', { invitationId: invitation.invitationId, displayName: 'Fixture', publicKey: key.jwk })
  const nonce = (requested.body.result as { nonce: string }).nonce
  gateway.pairing.approve(invitation.invitationId, gateway.pairing.pending(invitation.invitationId)!.confirmationCode, projects)
  const redeemed = await call(gateway, '/pair/redeem', { invitationId: invitation.invitationId, nonce, signature: key.sign(nonce) })
  return (redeemed.body.result as { token: string }).token
}
async function stream(gateway: RemoteGateway, token: string, fromSeq?: number) {
  const socket = await RawWebSocket.open(gateway.port, '/events', { origin: 'http://127.0.0.1:5173', protocols: ['ari-remote.v1', `bearer.${token}`] })
  socket.send(JSON.stringify({ type: 'events.desktop.subscribe', sessionId: 's', ...(fromSeq === undefined ? {} : { fromSeq }) }))
  const frames = []
  for (;;) {
    const message = remoteDesktopFrameSchema.parse(JSON.parse(await socket.nextMessage()))
    frames.push(message.frame)
    if (message.frame.kind === 'terminal') break
  }
  return { socket, frames }
}
async function journal(events: JournalEvent[]) {
  const dir = join(root, 'sessions', 's')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'journal.0000.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

describe('desktop host wire', () => {
  it('retains the legacy enum and authenticates catalog/resources with effective project scope', async () => {
    const repo = join(root, 'repository')
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://username:private-token@github.com/Me/App.git?secret=yes')
    git('remote', 'add', 'upstream', 'git@github.com:Acme/App.git')
    const desktop = {
      projects: async () => [{ id: 'p', name: 'Project', path: repo, status: 'ok' as const, defaultAgent: null,
        colorIndex: 0, createdAt: 1, lastOpenedAt: 0, open: true },
      { id: 'private', name: 'Secret project', path: repo, status: 'ok' as const, defaultAgent: null,
        colorIndex: 0, createdAt: 1, lastOpenedAt: 0, open: true }],
      resources: () => resources, version: () => version,
      createSession: async () => ({ sessionId: 'unused' }), stopChildren: async () => ({ stopped: 0 }),
      resume: { get: async () => ({ at: null }), schedule: async (_id: string, at: number) => ({ at }), cancel: async () => ({ cancelled: false }) },
      scm: { summary: async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Fixture' } }),
        status: async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Fixture' } }),
        review: async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Fixture' } }),
        diff: async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Fixture' } }) },
    }
    const gateway = await start(makeHost({ desktop }))
    const info = (await call(gateway, '/info', {})).body.result as { capabilities: string[]; machinesExtensions: { version: number; operations: string[] } }
    expect(info.capabilities.every((op) => remoteOperationSchema.safeParse(op).success)).toBe(true)
    expect(info.capabilities).not.toContain('project.catalog')
    expect(info.machinesExtensions.operations).toContain('project.catalog')
    expect((await call(gateway, '/query', { op: 'project.catalog' })).status).toBe(401)
    expect((await call(gateway, '/query', { op: 'host.resources' })).status).toBe(401)
    const token = await pair(gateway)
    const catalog = remoteProjectCatalogSchema.parse((await call(gateway, '/query', { op: 'project.catalog' }, token)).body.result)
    expect(catalog.projects).toHaveLength(1)
    expect(catalog.projects[0]!.repositoryIdentity).toMatchObject({ canonicalKey: 'github.com/acme/app', origin: { canonicalKey: 'github.com/me/app' } })
    expect(JSON.stringify(catalog)).not.toContain('private-token')
    expect(JSON.stringify(catalog)).not.toContain(repo)
    expect(remoteHostResourcesSchema.parse((await call(gateway, '/query', { op: 'host.resources' }, token)).body.result)).toEqual(resources)
    const permission = (await call(gateway, '/query', { op: 'host.permissions' }, token)).body.result
    expect(permission).toMatchObject({ projectScope: { kind: 'ids', projectIds: ['p'] }, allowTerminal: false, managedLeaseExpiresAt: null })
    expect((await call(gateway, '/query', { op: 'project.workspaces', projectId: 'private' }, token)).body.result).toBeNull()
  })

  it('streams every seq including zero and more than 2,000 events without readAll', async () => {
    const events: JournalEvent[] = [{ type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 }]
    for (let seq = 1; seq <= 2405; seq++) events.push({ type: 'session.updated', title: `Title ${seq}`, sessionId: 's', seq, at: seq + 1 })
    await journal(events)
    const forbidden = vi.spyOn(Journal.prototype, 'readAll').mockImplementation(async () => { throw new Error('whole-journal materialization') })
    const gateway = await start()
    const token = await pair(gateway)
    const { socket, frames } = await stream(gateway, token)
    socket.close()
    const received = frames.flatMap((frame) => frame.kind === 'chunk' ? frame.events : [])
    expect(received.map((event) => event.seq)).toEqual(events.map((event) => event.seq))
    expect(frames[0]).toEqual({ kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: 2405 })
    expect(frames.at(-1)).toEqual({ kind: 'terminal', replayOutcome: 'complete', seq: 2405, liveTurnId: null, reason: null })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('terminates zero-new-event resumes and marks corrupt/gapped history incomplete', async () => {
    await journal([{ type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 }])
    const gateway = await start()
    const token = await pair(gateway)
    const resumed = await stream(gateway, token, 0)
    resumed.socket.close()
    expect(resumed.frames.map((frame) => frame.kind)).toEqual(['start', 'terminal'])
    expect(resumed.frames.at(-1)).toMatchObject({ replayOutcome: 'complete', seq: 0, liveTurnId: null })
    const gap = await engine.replaySessionRangeChunks('s', { throughSeq: 2 }, async () => undefined)
    expect(gap).toMatchObject({ outcome: 'incomplete', seq: 0 })
    await store.closeJournal('s')
    await writeFile(join(root, 'sessions', 's', 'journal.0000.jsonl'),
      JSON.stringify({ type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 }) + '\ninvalid\n' +
      JSON.stringify({ type: 'session.updated', title: 'Gap', sessionId: 's', seq: 2, at: 3 }) + '\n')
    const corrupted = await stream(gateway, token)
    corrupted.socket.close()
    expect(corrupted.frames.at(-1)).toMatchObject({ replayOutcome: 'incomplete', liveTurnId: null })
  })

  it('awaits consumer backpressure and cancels a range without sending later chunks', async () => {
    const events: JournalEvent[] = [{ type: 'session.created', session: fixture(), sessionId: 's', seq: 0, at: 1 }]
    for (let seq = 1; seq < 300; seq++) events.push({ type: 'session.updated', title: 'T', sessionId: 's', seq, at: seq + 1 })
    await journal(events)
    const controller = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls = vi.fn(async () => gate)
    const reading = engine.replaySessionRangeChunks('s', { throughSeq: 299, signal: controller.signal }, calls)
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
    controller.abort(); release()
    expect(await reading).toMatchObject({ outcome: 'incomplete', reason: 'replay cancelled' })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('refuses secret and symlink paths for snapshot projections', async () => {
    await writeFile(join(root, '.env'), 'PRIVATE=1')
    await writeFile(join(root, 'safe.txt'), 'safe')
    expect(await remotePathIsSafe(root, '.env')).toBe(false)
    expect(await remotePathIsSafe(root, 'safe.txt')).toBe(true)
    const outside = join(root, 'outside')
    await mkdir(outside)
    try {
      await symlink(outside, join(root, 'link'), 'junction')
      expect(await remotePathIsSafe(root, 'link/safe.txt')).toBe(false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  })
})

describe('repository correlation', () => {
  it.each(['file:///repo', '../repo', '/repo', 'C:/repo', '\\\\server\\repo', 'repo'])('does not group local remote %s', (url) => {
    expect(normalizeRepositoryRemote(url)).toBeNull()
  })
  it('groups fetch upstream canonically while retaining differing origin as fork group', () => {
    expect(repositoryIdentityFromRemotes([{ name: 'origin', url: 'ssh://git@GitHub.com/Me/App.git/' },
      { name: 'upstream', url: 'https://user:secret@github.com/Acme/App.git?key=secret' }])).toMatchObject({
      canonicalKey: 'github.com/acme/app', origin: { canonicalKey: 'github.com/me/app' },
    })
    expect(normalizeRepositoryRemote('git@ssh.dev.azure.com:v3/Org/Project/Repo')).toBe('dev.azure.com/org/project/_git/repo')
    expect(normalizeRepositoryRemote('https://forge.internal.example/Team/App.git')).toBe('forge.internal.example/team/app')
  })
})
