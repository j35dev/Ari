// @vitest-environment node
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'
import { ProjectStore } from '@ari/engine/projects'
import { SessionStore } from '@ari/engine/session-store'
import { AgentControlService, type ControlHost } from '@ari/engine/agent-control'
import { DelegationSupervisor } from '@ari/engine/delegation-supervisor'
import { defaultSpeechShortcut } from '@ari/contracts/settings'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { AdapterSession } from '@ari/providers/driver'
import { DriverRegistry } from '@ari/providers/registry'
import { AttachmentStore } from './attachments'
import { Engine } from './engine'
import { ResumeSchedule } from './resume-schedule'
import { useTempDirs } from './testing/temp-dirs'
import fixture from './testing/release-profile-0312.fixture.json'
import desktopPackage from '../../package.json'

const temp = useTempDirs()
let root: string
let profile: string
let store: SessionStore
const ids = [fixture.expected.parentId, fixture.expected.runningId, fixture.expected.heldId]
const upgrading = desktopPackage.version !== fixture.source.version

// Relocate only the synthetic path token, without parsing data with candidate schemas.
function relocate(text: string): string {
  return text.replace(/"\{\{PROFILE_ROOT\}\}[^"]*"/g, (encoded) => {
    const path = JSON.parse(encoded) as string
    return JSON.stringify(
      join(root, ...path.slice(fixture.pathToken.length).split(/[\\/]/).filter(Boolean)),
    )
  })
}

beforeEach(async () => {
  root = await realpath(temp('ari-release-profile-upgrade-'))
  profile = join(root, 'profile')
  expect(fixture.source).toMatchObject({
    version: '0.3.12',
    commit: '50ee55d273ab1a0240111638dba05c894ce2d3d1',
  })
  for (const directory of fixture.directories)
    await mkdir(join(root, directory), { recursive: true })
  for (const file of fixture.files) {
    const path = join(root, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.base64 ? Buffer.from(file.base64, 'base64') : relocate(file.utf8!))
  }
  store = new SessionStore({ rootDir: join(profile, 'sessions') })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of ids) await store.closeJournal(id)
})

function projects(): ProjectStore {
  return new ProjectStore({
    dir: profile,
    builtIn: { id: 'helm', name: 'Aria', path: join(profile, 'aria') },
  })
}

function controlHost(): ControlHost {
  const unexpected = vi.fn(async () => {
    throw new Error('Unexpected external effect in upgrade fixture')
  })
  return {
    store,
    version: 'profile-upgrade-fixture',
    policy: () => new SettingsStore({ dir: profile }).current.delegation,
    providers: vi.fn(async () => []),
    create: unexpected,
    dispatch: unexpected,
    isolate: unexpected,
    approve: unexpected,
    diff: unexpected,
    integrate: unexpected,
    release: unexpected,
    record: (id, event) => store.append(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace: async () => join(root, 'workspaces/open'),
  }
}

it('cold-loads the frozen 0.3.12 profile without losing projects, transcripts, queues or staged bytes', async () => {
  const journalFiles = fixture.files.filter((file) => file.path.endsWith('.jsonl'))
  const originalJournals = await Promise.all(
    journalFiles.map((file) => readFile(join(root, file.path), 'utf8')),
  )
  const settings = new SettingsStore({ dir: profile })
  const loaded = await settings.load()
  // A saved Ask default is the one preference an upgrade changes: full auto is now everyone's default.
  expect(loaded.sessions).toEqual({ defaultDriverKind: 'codex', defaultPermissionMode: 'full' })
  expect(loaded.appearance).toMatchObject({ mode: 'graphite', themeId: 'graphite', fontSize: 15 })
  expect(loaded.speech).toMatchObject({
    enabled: true,
    modelId: 'tiny',
    modelPath: join(root, 'models/tiny.gguf'),
    shortcut: 'ctrl+shift+space',
  })
  // Exact 0.3.13 source keeps shortcut as Aria and adds a separate general binding.
  // Candidate metadata enables these checks; a missing new field must fail.
  if (upgrading) {
    const general = process.platform === 'darwin' ? 'shift+meta+d' : 'ctrl+alt+d'
    expect(loaded.speech).toMatchObject({ dictationShortcut: general, duckAudio: true })
    expect(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')).speech).toMatchObject(
      { shortcut: 'ctrl+shift+space', dictationShortcut: general },
    )
  }
  const registry = projects()
  const rows = await registry.load()
  expect(rows.map((row) => row.id)).toEqual([
    'helm',
    fixture.expected.projectId,
    fixture.expected.missingId,
  ])
  expect(registry.get(fixture.expected.projectId)).toMatchObject({
    name: 'Synthetic saved project',
    path: join(root, 'workspaces/open'),
    open: true,
    status: 'ok',
    defaultAgent: fixture.expected.agent,
  })
  expect(registry.get(fixture.expected.missingId)).toMatchObject({
    status: 'missing',
    open: false,
    defaultAgent: fixture.expected.agent,
  })
  expect(registry.get(fixture.expected.removedId)).toBeNull()
  // An index can trail its journal after a crash. Derive this stale cache
  // from the real captured v5 sidecar, retaining the authoritative journal.
  const indexPath = join(profile, 'sessions', fixture.expected.parentId, 'index.json')
  const stale = JSON.parse(await readFile(indexPath, 'utf8'))
  expect(stale.version).toBe(5)
  stale.journalBytes = 0
  stale.title = 'Synthetic stale cached title'
  delete stale.hierarchy.lead
  delete stale.hierarchy.createdBy
  await writeFile(indexPath, JSON.stringify(stale))
  expect((await store.listSessions()).map((row) => row.id).sort()).toEqual([...ids].sort())
  const parentJournal = journalFiles.find((file) =>
    file.path.includes(`/${fixture.expected.parentId}/`),
  )!
  expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({
    title: 'Synthetic upgrade conversation',
    hierarchy: { lead: true, createdBy: { kind: 'human' } },
    journalBytes: (await stat(join(root, parentJournal.path))).size,
  })
  for (const id of ids) {
    const model = await store.load(id)
    const expected = fixture.expected.models[id as keyof typeof fixture.expected.models]
    expect({
      session: model.session,
      messages: model.messages,
      queuedMessages: model.queuedMessages,
      usage: model.usage,
      providerSessionId: model.providerSessionId,
      activeTurnId: model.activeTurnId,
      operations: model.orchestration?.operations ?? {},
      inbox: model.inbox ?? {},
    }).toEqual(expected)
    expect(store.replayDiagnostics(id).rejectedCount).toBe(0)
  }
  expect(
    await Promise.all(journalFiles.map((file) => readFile(join(root, file.path), 'utf8'))),
  ).toEqual(originalJournals)
  expect(
    await new AttachmentStore(join(profile, 'attachments')).read(fixture.expected.attachment.id),
  ).toEqual({
    name: 'synthetic.png',
    mimeType: 'image/png',
    size: 68,
    dataBase64: fixture.expected.png,
  })
  const dispatch = vi.fn(async () => ({ accepted: true }))
  const schedule = new ResumeSchedule({
    path: join(profile, 'resume-schedule.json'),
    store,
    dispatch,
    now: () => fixture.expected.at,
  })
  await schedule.load() // Never start a sweep/timer in the upgrade check.
  expect(schedule.list()).toMatchObject([
    {
      sessionId: fixture.expected.parentId,
      prompt: 'Synthetic scheduled check',
      at: fixture.expected.at + 60_000,
      every: 600_000,
    },
  ])
  expect(dispatch).not.toHaveBeenCalled()

  // A subsequent real write/reload keeps saved defaults and restores the original tombstone ID.
  await settings.update({ appearance: { reducedMotion: true } })
  const restored = await registry.add(join(root, 'workspaces/removed'))
  expect(restored).toMatchObject({
    id: fixture.expected.removedId,
    defaultAgent: fixture.expected.agent,
  })
  const cold = projects()
  await cold.load()
  expect(cold.get(restored.id)?.defaultAgent).toEqual(fixture.expected.agent)
  expect((await new SettingsStore({ dir: profile }).load()).speech).toEqual(loaded.speech)
  expect(await readFile(join(root, 'workspaces/open/keep.txt'), 'utf8')).toBe(
    'Synthetic workspace content — preserve me.\n',
  )
})

it('persists the known startup shortcut/approval migrations once while retaining saved preferences', async () => {
  const path = join(profile, 'settings.json')
  const raw = JSON.parse(await readFile(path, 'utf8'))
  // Supported historical fields, sourced from settings.ts and existing speech settings tests.
  delete raw.delegationApprovalMigrated
  raw.delegation.approvalMode = 'first-per-root'
  raw.speech.shortcut = 'alt-right'
  await writeFile(path, JSON.stringify(raw))
  const settings = new SettingsStore({ dir: profile })
  const migrated = await settings.load()
  expect(migrated.speech).toMatchObject({
    enabled: true,
    modelId: 'tiny',
    modelPath: join(root, 'models/tiny.gguf'),
    shortcut: defaultSpeechShortcut(process.platform),
  })
  expect(migrated.delegation.approvalMode).toBe('never')
  const saved = await readFile(path, 'utf8')
  expect(JSON.parse(saved).delegationApprovalMigrated).toBe(true)
  expect(await new SettingsStore({ dir: profile }).load()).toEqual(migrated)
  expect(await readFile(path, 'utf8')).toBe(saved)
})

it('keeps a saved Aria binding when it occupies the newer general dictation default', async () => {
  const path = join(profile, 'settings.json')
  const raw = JSON.parse(await readFile(path, 'utf8'))
  const aria = process.platform === 'darwin' ? 'shift+meta+d' : 'ctrl+alt+d'
  raw.speech.shortcut = aria
  await writeFile(path, JSON.stringify(raw))
  const loaded = await new SettingsStore({ dir: profile }).load()
  expect(loaded.speech).toMatchObject({ shortcut: aria, enabled: true, modelId: 'tiny' })
  if (upgrading) {
    expect(loaded.speech).toMatchObject({ dictationShortcut: 'ctrl+alt+shift+d' })
    expect(JSON.parse(await readFile(path, 'utf8')).speech).toMatchObject({
      shortcut: aria,
      dictationShortcut: 'ctrl+alt+shift+d',
    })
  }
})

it('reuses completed receipts and preserves uncertain worker identity through a fresh service', async () => {
  const host = controlHost()
  const control = new AgentControlService(host)
  expect(
    await control.invoke(
      fixture.expected.parentId,
      'session.message',
      fixture.expected.messageParams,
    ),
  ).toEqual(fixture.expected.messageResult)
  const before = (await store.load(fixture.expected.parentId)).orchestration!.operations
  const uncertain = Object.values(before).find((operation) => operation.method === 'session.spawn')!
  expect(uncertain).toMatchObject({
    status: 'uncertain',
    result: { recovery: { childSessionId: fixture.expected.heldId, stage: 'session_created' } },
  })
  const result = await control.invoke(
    fixture.expected.parentId,
    'session.spawn',
    fixture.expected.spawnParams,
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'uncertain_outcome' } })
  expect((await store.listSessions()).map((row) => row.id).sort()).toEqual([...ids].sort())
  expect(
    (await store.load(fixture.expected.parentId)).orchestration!.operations[uncertain.operationId],
  ).toMatchObject({ result: uncertain.result })
  for (const effect of [
    host.create,
    host.dispatch,
    host.isolate,
    host.approve,
    host.release,
    host.providers,
  ])
    expect(effect).not.toHaveBeenCalled()
})

it('recovers interrupted child state and drains held work only through the scripted engine boundary', async () => {
  const requests: AdapterSession[] = []
  const registry = new DriverRegistry()
  registry.register({
    kind: 'codex',
    create: async (request) => {
      requests.push(request)
      return {
        start: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'text-delta', text: 'Synthetic resumed reply' }
            yield { type: 'done' }
          })(),
        interrupt: () => undefined,
        dispose: async () => undefined,
      }
    },
  })
  const attachments = new AttachmentStore(join(profile, 'attachments'))
  const engine = new Engine({
    store,
    registry,
    publish: () => undefined,
    resolveWorkspace: async () => join(root, 'workspaces/open'),
    resolveAttachmentPath: (id) => attachments.pathFor(id),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
  })
  // Await the actual recovery dispatch, not timers or an implementation-only status flag.
  const wait = (label: string) => {
    let resolve!: () => void
    const event = new Promise<void>((done) => {
      resolve = done
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    return {
      wait: async () => {
        const timeout = new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)
        })
        try {
          await Promise.race([event, timeout])
        } finally {
          clearTimeout(timer)
        }
      },
      resolve,
      cancel: () => clearTimeout(timer),
    }
  }
  const recovered = wait('startup interruption')
  const heldSettled = wait('held queue settlement')
  const unsubscribe = store.subscribe((event) => {
    if (event.sessionId === fixture.expected.heldId && event.type === 'turn.settled')
      heldSettled.resolve()
  })
  const supervisor = new DelegationSupervisor({
    store,
    policy: () => new SettingsStore({ dir: profile }).current.delegation,
    dispatch: async (command, origin) => {
      const result = await engine.dispatch(command, origin)
      if (command.type === 'turn.interrupt' && command.sessionId === fixture.expected.runningId)
        recovered.resolve()
      return result
    },
    record: (id, event) => engine.record(id, event),
    subscribe: (listener) => store.subscribe(listener),
    isRunning: (id) => engine.hasLiveTurn(id),
  })
  try {
    const userQueue = (await store.load(fixture.expected.parentId)).queuedMessages
    supervisor.start()
    await recovered.wait()
    await Promise.resolve(supervisor.close())
    const interrupted = await store.load(fixture.expected.runningId)
    expect(interrupted).toMatchObject({
      activeTurnId: null,
      lastTurn: { turnId: 'turn_unconfirmed', stopReason: 'interrupted' },
      providerSessionId: 'synthetic-native-thread',
    })
    expect(interrupted.queuedMessages).toEqual(
      fixture.expected.models.sess_upgrade_running.queuedMessages,
    )
    expect(requests).toEqual([])
    await engine.drainHeld()
    await heldSettled.wait()
    await engine.shutdown()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sessionId: fixture.expected.heldId,
      modelId: 'saved-model',
      effort: 'xhigh',
      permissionMode: 'full',
      attachments: [
        {
          id: fixture.expected.attachment.id,
          path: await attachments.pathFor(fixture.expected.attachment.id),
        },
      ],
    })
    expect(requests[0]?.prompt).toContain('Continue held assignment')
    expect((await store.load(fixture.expected.heldId)).queuedMessages).toEqual([])
    expect((await store.load(fixture.expected.parentId)).queuedMessages).toEqual(userQueue)
    expect((await stat(join(root, 'workspaces/open'))).isDirectory()).toBe(true)
  } finally {
    recovered.cancel()
    heldSettled.cancel()
    await Promise.resolve(supervisor.close())
    unsubscribe()
    await engine.shutdown()
  }
})
