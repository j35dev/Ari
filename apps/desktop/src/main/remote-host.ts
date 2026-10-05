import { realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { GitService } from '@ari/engine/git'
import { parseDiff, type DiffFile } from '@ari/shared/diff-parse'
import { createLogger } from '@ari/shared/logger'
import { driverKindSchema, type DriverKind, type PermissionMode } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import type { Message } from '@ari/contracts/message'
import type {
  RemoteApproval,
  RemoteAttention,
  RemoteChanges,
  RemoteCommand,
  RemoteEffortOption,
  RemoteInput,
  RemoteModelCatalog,
  RemoteOperation,
  RemoteProject,
} from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { RemoteCaller, RemoteHost } from '@ari/remote-gateway/host'
import type { PairingService } from '@ari/remote-gateway/pairing'
import type { Engine } from './engine'
import type { SessionStore } from '@ari/engine/session-store'
import { queryRemoteFiles } from './remote-files'
import { RemoteAttachments } from './remote-attachments'
import type { AttachmentStore } from './attachments'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { RemoteTerminals } from './remote-terminals'
import type { RemoteIntegration } from './remote-integration'
import { ControlFailure } from '@ari/contracts/agent-control'
import type { RemoteForkCommand, RemoteForkResult } from './remote-fork'
import { remoteCatalogDefaults } from './remote-catalog'

/**
 * The desktop's implementation of the gateway's port.
 *
 * Everything a remote client can reach goes through here, and what it can
 * reach is the list in {@linkcode OPERATIONS} — not the RPC surface the
 * renderer uses. Optional terminal access requires an explicit device grant;
 * files use the session workspace boundary. No provider login or arbitrary
 * IPC is exposed. Forking uses a fixed native delegation operation in process.
 *
 * Two rules shape every method below:
 *
 * A device sees only the projects the user granted it at pairing. The check is
 * on the session's own `projectId` read from the journal, never on a project id
 * the caller supplied, so a device cannot name its way into someone else's
 * session.
 *
 * A paired phone chooses a session's effort and permission mode as the desktop
 * composer does. The desktop's configured mode is only the default for a
 * session the phone created without choosing.
 */

export interface RemoteHostDeps {
  engine: Engine
  store: SessionStore
  /** Providers this desktop can actually drive right now. */
  driverKinds: readonly DriverKind[] | (() => readonly DriverKind[])
  /**
   * The mode for a session whose creator did not choose one. Read at call time
   * rather than captured, so changing the setting takes effect without
   * restarting the gateway.
   */
  defaultPermissionMode: () => PermissionMode
  /** Provider for a session created from a phone, when the user has a default. */
  defaultDriverKind: () => DriverKind | null
  /** Whether a project id names a project on this machine. */
  hasProject: (projectId: string) => Promise<boolean>
  /** Every project this desktop has registered, for the phone's picker. */
  listProjects: () => Promise<{ id: string; name: string }[]>
  /** Providers this desktop can run, with their catalog models. */
  listModels: () => Promise<RemoteModelCatalog['providers']>
  /**
   * Effort levels for one model, where they differ from the provider's list.
   * May start an agent to ask it, so the implementation is expected to cache.
   */
  effortsForModel?: (kind: DriverKind, modelId: string | null) => Promise<RemoteEffortOption[]>
  /** Owns the device records `device.list` and `device.revoke` read and write. */
  pairing: PairingService
  mintSessionId: () => string
  attachments?: Pick<AttachmentStore, 'stage' | 'read'>
  terminals?: RemoteTerminals
  integration?: RemoteIntegration
  fork?: (
    deviceId: string,
    command: RemoteForkCommand & { driverKind: DriverKind; modelId?: string },
  ) => Promise<RemoteForkResult>
}

const OPERATIONS: readonly RemoteOperation[] = [
  'session.list',
  'session.get',
  'session.create',
  'session.archive',
  'session.update',
  'attention.list',
  'files.list',
  'files.read',
  'session.prompt',
  'session.queue',
  'session.steer',
  'session.interrupt',
  'approval.respond',
  'input.respond',
  'changes.files',
  'changes.diff',
  'project.list',
  'models.list',
  'events.subscribe',
  'device.list',
  'device.revoke',
]

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
  const { store, engine, pairing } = deps
  const attachments =
    deps.attachments === undefined ? null : new RemoteAttachments(deps.attachments)
  function registered(kind: DriverKind): boolean {
    return (
      typeof deps.driverKinds === 'function' ? deps.driverKinds() : deps.driverKinds
    ).includes(kind)
  }
  async function modelCatalog(): Promise<RemoteModelCatalog> {
    const providers = (await deps.listModels()).map((provider) => ({
      ...provider,
      available: provider.available !== false && registered(provider.driverKind),
    }))
    return {
      providers,
      defaults: remoteCatalogDefaults(
        providers,
        deps.defaultDriverKind(),
        deps.defaultPermissionMode(),
      ),
    }
  }

  /** The model's own levels when the desktop can ask for them, else the provider's. */
  async function effortOptions(
    kind: DriverKind,
    modelId: string | null,
  ): Promise<RemoteEffortOption[]> {
    const specific = (await deps.effortsForModel?.(kind, modelId)) ?? []
    if (specific.length > 0) return specific
    const provider = (await modelCatalog()).providers.find((row) => row.driverKind === kind)
    return provider?.efforts ?? []
  }

  /** The engine takes any effort string, so an id nobody offered is stopped here. */
  async function offersEffort(
    kind: DriverKind,
    modelId: string | null,
    effort: string,
  ): Promise<boolean> {
    return (await effortOptions(kind, modelId)).some((option) => option.id === effort)
  }

  /** Whether the caller was granted this project at pairing. */
  function granted(caller: RemoteCaller, projectId: string): boolean {
    return caller.projectIds.includes(projectId)
  }

  /**
   * The session as the caller is allowed to see it, or `undefined`. Returning
   * `undefined` for both "no such session" and "not yours" is deliberate: a
   * distinct answer would tell an unpaired device that a session exists.
   */
  async function visible(caller: RemoteCaller, sessionId: string): Promise<Session | undefined> {
    const { session } = await store.load(sessionId)
    if (session === null) return undefined
    return granted(caller, session.projectId) ? session : undefined
  }

  async function listSessions(caller: RemoteCaller): Promise<SessionSummary[]> {
    const all = await store.listSessions()
    // `SessionListEntry` is the shape `SessionSummary` describes, so the two
    // listings are the same objects rather than two mappings that could drift.
    return all.filter((entry) => granted(caller, entry.projectId))
  }

  async function attention(
    caller: RemoteCaller,
    params: Record<string, unknown>,
  ): Promise<RemoteAttention> {
    const sessions = (await listSessions(caller)).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    const limit = Math.min(100, Math.max(1, Number(params['limit'] ?? 50)))
    const items: RemoteAttention['items'] = []
    for (const summary of sessions) {
      if (typeof params['cursor'] === 'string' && summary.id <= params['cursor']) continue
      const model = await store.load(summary.id)
      const session = model.session
      if (session === null || !granted(caller, session.projectId)) continue
      if (
        model.pendingApprovals.length === 0 &&
        model.pendingInputs.length === 0 &&
        session.status !== 'error'
      )
        continue
      if (items.length === limit) return { items, nextCursor: items.at(-1)?.sessionId ?? null }
      items.push({
        sessionId: session.id,
        projectId: session.projectId,
        title: session.title,
        status: session.status,
        updatedAt: session.updatedAt,
        seq: Math.max(0, model.lastSeq),
        pendingApprovals: model.pendingApprovals,
        pendingInputs: model.pendingInputs,
        error:
          session.status === 'error'
            ? 'The last run failed. Open the session to inspect the failure.'
            : null,
      })
    }
    return { items, nextCursor: null }
  }

  /**
   * The granted projects a session can be started in. Filtered by the device's
   * grant as well as by what the desktop has registered: a grant for a project
   * that was since removed must not offer a session that cannot be created.
   */
  async function listProjects(caller: RemoteCaller): Promise<RemoteProject[]> {
    const sessions = await store.listSessions()
    const projects: RemoteProject[] = []
    for (const project of await deps.listProjects()) {
      if (!granted(caller, project.id)) continue
      projects.push({
        id: project.id,
        name: project.name,
        sessionCount: sessions.filter((entry) => entry.projectId === project.id).length,
      })
    }
    return projects
  }

  /**
   * `session.get` reads the same list `session.list` does and picks one entry,
   * rather than projecting a summary of its own. It costs a scan of the sidecar
   * indexes, and it buys the guarantee that a client which lists a session and
   * then opens it is looking at the same record.
   */
  async function getSession(
    caller: RemoteCaller,
    sessionId: string,
  ): Promise<
    | {
        session: Session
        summary: SessionSummary
        seq: number
        messages: Message[]
        pendingApprovals: RemoteApproval[]
        pendingInputs: RemoteInput[]
      }
    | undefined
  > {
    const { session, messages, lastSeq, pendingApprovals, pendingInputs } =
      await store.load(sessionId)
    if (session === null || !granted(caller, session.projectId)) return undefined
    const summary = (await listSessions(caller)).find((entry) => entry.id === sessionId)
    if (summary === undefined) return undefined
    // The state and the journal high-water mark it was taken at travel
    // together, so a subscriber resuming from `seq` sees no gap and no repeat.
    //
    // The projection already carries what is waiting on a human — the desktop
    // replays the journal to render its own approval prompt from the same
    // list, so a phone and the desktop cannot disagree about what is open.
    return { session, summary, seq: lastSeq, messages, pendingApprovals, pendingInputs }
  }

  interface SessionChanges {
    files: DiffFile[]
    base: RemoteChanges['base']
    error: string | null
  }

  /**
   * The session's working tree as a per-file change list, read with git alone.
   *
   * The workspace resolves server-side from the session the caller was granted;
   * no client-supplied path reaches the disk. Only a workspace at or inside the
   * repo it belongs to is read, so a session whose folder moved out from under
   * git answers "unavailable" rather than a diff of the wrong tree. Untracked
   * files come from status rather than the diff, which never contains them, and
   * carry no hunks — the phone says so instead of showing an empty preview.
   */
  async function changes(caller: RemoteCaller, sessionId: string): Promise<SessionChanges | null> {
    const session = await visible(caller, sessionId)
    if (session === undefined) return null
    const workspace = await engine.workspace(session)
    const base: RemoteChanges['base'] =
      session.workspace?.kind === 'managed-worktree' ? 'session-base' : 'workspace-head'
    const unavailable: SessionChanges = {
      files: [],
      base,
      error: 'Changes are unavailable for this workspace.',
    }
    if (workspace === null) return unavailable
    const git = new GitService()
    const root = await git.runPlumbing(workspace, ['rev-parse', '--show-toplevel'])
    if (!root.ok) return unavailable
    let top: string
    let dir: string
    try {
      // Both resolved: a symlinked checkout must not escape the comparison.
      top = await realpath(root.value.stdout.trim())
      dir = await realpath(workspace)
    } catch {
      createLogger('desktop:remote').warn('remote workspace resolution failed')
      return unavailable
    }
    if (dir !== top && !dir.startsWith(top + sep)) return unavailable
    const ref =
      session.workspace?.kind === 'managed-worktree' ? session.workspace.baseCommit : 'HEAD'
    const diff = await git.runPlumbing(workspace, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      ref,
      '--',
    ])
    if (!diff.ok) {
      createLogger('desktop:remote').warn('remote diff failed', { code: diff.error.code })
      return {
        ...unavailable,
        error: 'Could not read changes. The diff may exceed the size limit.',
      }
    }
    const files = parseDiff(diff.value.stdout).files
    const seen = new Set(files.map((file) => file.path))
    const status = await git.status(workspace)
    if (status.ok) {
      for (const entry of status.value.files) {
        // Repo-relative by construction; anything else is not listed.
        if (entry.kind !== 'untracked' || seen.has(entry.path)) continue
        if (entry.path.includes('..')) continue
        if (!join(top, entry.path).startsWith(top + sep)) continue
        files.push({ path: entry.path, isNew: true, hunks: [] })
        seen.add(entry.path)
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { files, base, error: null }
  }

  return {
    capabilities: () => [
      ...OPERATIONS,
      ...(deps.fork === undefined ? [] : (['session.fork'] as const)),
      ...(attachments === null ? [] : (['attachments.stage', 'attachments.read'] as const)),
      ...(deps.terminals === undefined
        ? []
        : ([
            'terminal.create',
            'terminal.read',
            'terminal.write',
            'terminal.resize',
            'terminal.kill',
          ] as const)),
      ...(deps.integration === undefined
        ? []
        : (['changes.preview', 'changes.integrate'] as const)),
      ...(deps.effortsForModel === undefined ? [] : (['models.efforts'] as const)),
    ],
    listSessions,
    listProjects,
    getSession,
    replay: async (caller, sessionId, fromSeq) => {
      if ((await visible(caller, sessionId)) === undefined) return undefined
      const events = await engine.replaySession(sessionId)
      return events.filter((event) => event.seq > fromSeq)
    },
    query: async (caller, op, params) => {
      switch (op) {
        case 'session.list':
          return listSessions(caller)
        case 'session.get':
          return (await getSession(caller, String(params['sessionId']))) ?? null
        case 'attention.list':
          return attention(caller, params)
        case 'attachments.read': {
          const sessionId = String(params['sessionId'])
          const model = await store.load(sessionId)
          if (model.session === null || !granted(caller, model.session.projectId)) return null
          const attachment =
            (await attachments?.read(caller, sessionId, String(params['attachmentId']), model)) ??
            null
          return {
            attachment,
            error:
              attachment === null
                ? 'This image is unavailable or exceeds the mobile size limit.'
                : null,
          }
        }
        case 'terminal.read': {
          const sessionId = String(params['sessionId'])
          if ((await visible(caller, sessionId)) === undefined) return null
          return (
            deps.terminals?.read(
              caller,
              sessionId,
              String(params['terminalId']),
              Number(params['fromSeq'] ?? 0),
            ) ?? null
          )
        }
        case 'changes.preview': {
          if ((await visible(caller, String(params['sessionId']))) === undefined) return null
          if (deps.integration === undefined)
            return { preview: null, error: 'Integration is unavailable.' }
          try {
            return {
              preview: await deps.integration.preview(caller, String(params['sessionId'])),
              error: null,
            }
          } catch (error) {
            return {
              preview: null,
              error:
                error instanceof ControlFailure
                  ? error.message
                  : 'Unable to inspect changes. Check Git on the desktop.',
            }
          }
        }
        case 'files.list':
        case 'files.read': {
          const session = await visible(caller, String(params['sessionId']))
          if (session === undefined) return null
          const workspace = await engine.workspace(session)
          const path = typeof params['path'] === 'string' ? params['path'] : ''
          if (workspace === null)
            return op === 'files.list'
              ? {
                  path,
                  entries: [],
                  nextCursor: null,
                  error: 'Files are unavailable for this workspace.',
                }
              : {
                  path,
                  kind: null,
                  size: null,
                  content: null,
                  error: 'Files are unavailable for this workspace.',
                }
          return queryRemoteFiles(workspace, {
            op,
            path,
            ...(typeof params['cursor'] === 'string' ? { cursor: params['cursor'] } : {}),
            ...(typeof params['limit'] === 'number' ? { limit: params['limit'] } : {}),
          })
        }
        case 'changes.files': {
          const result = await changes(caller, String(params['sessionId']))
          if (result === null) return null
          return {
            ...result,
            files: result.files.map((file) => ({
              path: file.path,
              ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
              ...(file.isNew === true ? { isNew: true as const } : {}),
              ...(file.isDeleted === true ? { isDeleted: true as const } : {}),
              ...(file.isBinary === true ? { isBinary: true as const } : {}),
            })),
          }
        }
        case 'changes.diff': {
          const result = await changes(caller, String(params['sessionId']))
          if (result === null) return null
          return {
            file: result.files.find((file) => file.path === params['path']) ?? null,
            error: result.error,
          }
        }
        case 'project.list':
          return listProjects(caller)
        case 'models.list':
          // Capability-gated like everything else, but not project-scoped: it
          // names providers and catalog models, nothing about the user's work.
          return modelCatalog()
        case 'models.efforts': {
          const kind = driverKindSchema.parse(params['driverKind'])
          const modelId = typeof params['modelId'] === 'string' ? params['modelId'] : null
          return { efforts: await effortOptions(kind, modelId) }
        }
        case 'device.list':
          // A paired device already acts as the user, so seeing and revoking
          // the user's other devices is the management feature the design
          // calls for, not an escalation.
          return pairing.devices()
        case 'device.revoke':
          return { revoked: pairing.revoke(String(params['deviceId'])) }
        default:
          throw new Error(`no query for ${op}`)
      }
    },
    subscribe: (_caller, sessionId, onEvent) => {
      // Whether the device is still paired is re-checked by the gateway at
      // delivery, on every frame. What is decided here is only which session's
      // events this subscriber asked for.
      return store.subscribe((event) => {
        if (event.sessionId === sessionId) onEvent(event)
      })
    },
    execute: execute,
  }

  async function execute(
    caller: RemoteCaller,
    command: RemoteCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
    if (command.op === 'session.create') return createSession(caller, command)
    if (command.op === 'changes.integrate') {
      if (deps.integration === undefined)
        return {
          ok: false,
          code: 'unsupported_capability',
          message: 'integrating changes is not available on this desktop',
        }
      try {
        return {
          ok: true,
          result: await deps.integration.integrate(
            caller,
            command.sessionId,
            command.snapshotCommit,
            command.expectedParentSnapshot,
          ),
        }
      } catch (error) {
        return {
          ok: false,
          code: 'conflict',
          message:
            error instanceof ControlFailure
              ? error.message
              : 'Integration failed. Inspect the parent workspace before retrying.',
        }
      }
    }

    const session = await visible(caller, command.sessionId)
    if (session === undefined) {
      return { ok: false, code: 'not_found', message: 'no such session' }
    }
    if (command.op === 'session.fork') {
      if (deps.fork === undefined)
        return {
          ok: false,
          code: 'unsupported_capability',
          message: 'Isolated child tasks are unavailable on this desktop.',
        }
      const driverKind = command.driverKind ?? session.driverKind
      const provider = (await modelCatalog()).providers.find((row) => row.driverKind === driverKind)
      const { modelId: requestedModel, ...request } = command
      const modelId =
        requestedModel ??
        (driverKind === session.driverKind ? session.modelId : null) ??
        provider?.defaultModelId ??
        null
      if (provider?.available !== true)
        return {
          ok: false,
          code: 'unsupported_capability',
          message: provider?.reason ?? 'Requested provider is unavailable.',
        }
      return deps.fork(caller.deviceId, {
        ...request,
        driverKind,
        ...(modelId === null || (modelId === 'default' && driverKind !== 'ari-core')
          ? {}
          : {
              modelId:
                provider.models.find((model) => model.aliases?.includes(modelId))?.id ?? modelId,
            }),
      })
    }
    if (
      command.op === 'terminal.create' ||
      command.op === 'terminal.write' ||
      command.op === 'terminal.resize' ||
      command.op === 'terminal.kill'
    ) {
      const workspace = await engine.workspace(session)
      if (deps.terminals === undefined || workspace === null)
        return {
          ok: false,
          code: 'unsupported_capability',
          message: 'Terminal access is unavailable for this workspace.',
        }
      return deps.terminals.execute(caller, command, workspace)
    }
    if (command.op === 'attachments.stage') {
      if (attachments === null)
        return {
          ok: false,
          code: 'unsupported_capability',
          message: 'image attachments are unavailable',
        }
      const refs = await attachments.stage(caller, command)
      return refs === null
        ? {
            ok: false,
            code: 'conflict',
            message:
              'Use a PNG, JPEG, GIF or WebP under 1 MB; remove or send pending images before adding more.',
          }
        : { ok: true, result: { attachments: refs } }
    }
    if (command.op === 'session.prompt' || command.op === 'session.queue') {
      const ids = command.attachmentIds ?? []
      const refs =
        ids.length === 0
          ? []
          : (attachments?.resolve(caller, session.id, ids, await store.load(session.id)) ?? null)
      if (refs === null)
        return { ok: false, code: 'not_found', message: 'an image is unavailable; attach it again' }
      if (command.text.trim().length === 0 && refs.length === 0)
        return { ok: false, code: 'conflict', message: 'add a message or an image' }
      return dispatch(commandToEngine(command, refs))
    }
    if (command.op === 'session.update') {
      if (
        command.title === undefined &&
        command.pinned === undefined &&
        command.modelId === undefined &&
        command.permissionMode === undefined &&
        command.effort === undefined
      ) {
        return { ok: false, code: 'conflict', message: 'no session changes were supplied' }
      }
      if (
        typeof command.effort === 'string' &&
        !(await offersEffort(
          session.driverKind,
          command.modelId === undefined ? (session.modelId ?? null) : command.modelId,
          command.effort,
        ))
      ) {
        return {
          ok: false,
          code: 'unsupported_capability',
          message: 'this provider does not offer that effort level',
        }
      }
      if (command.modelId === null && session.driverKind === 'ari-core') {
        const provider = (await modelCatalog()).providers.find(
          (row) => row.driverKind === 'ari-core',
        )
        if (provider?.defaultModelId == null || provider.available !== true)
          return {
            ok: false,
            code: 'unsupported_capability',
            message:
              provider?.reason ??
              'Configure an endpoint on the desktop before selecting its default.',
          }
        return dispatch(commandToEngine({ ...command, modelId: provider.defaultModelId }))
      }
      if (command.modelId !== undefined && command.modelId !== null) {
        const provider = (await modelCatalog()).providers.find(
          (entry) => entry.driverKind === session.driverKind,
        )
        if (command.modelId === 'default' && session.driverKind !== 'ari-core')
          return dispatch(commandToEngine({ ...command, modelId: null }))
        if (
          !provider?.models.some(
            (model) =>
              model.id === command.modelId || model.aliases?.includes(command.modelId as string),
          )
        ) {
          return {
            ok: false,
            code: 'unsupported_capability',
            message: 'this provider cannot run that model',
          }
        }
      }
    }
    return dispatch(commandToEngine(command))
  }

  async function dispatch(
    command: Command,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
    const outcome = await engine.dispatch(command)
    if (outcome.accepted) return { ok: true, result: { accepted: true } }
    // The engine's reason is the honest answer — "a turn is already running"
    // is actionable where a bare "conflict" is not.
    return {
      ok: false,
      code: 'conflict',
      message: outcome.reason ?? 'the engine refused the command',
    }
  }

  async function createSession(
    caller: RemoteCaller,
    command: Extract<RemoteCommand, { op: 'session.create' }>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
    if (!granted(caller, command.projectId)) {
      return { ok: false, code: 'not_found', message: 'no such project' }
    }
    if (!(await deps.hasProject(command.projectId))) {
      return { ok: false, code: 'not_found', message: 'no such project' }
    }
    const catalog = await modelCatalog()
    const driverKind = command.driverKind ?? catalog.defaults?.driverKind ?? null
    const provider = catalog.providers.find((row) => row.driverKind === driverKind)
    if (driverKind === null || provider?.available !== true) {
      return {
        ok: false,
        code: 'unsupported_capability',
        message:
          provider?.reason ??
          'No provider is available. Configure or sign in to a provider on the desktop.',
      }
    }

    const modelId =
      command.modelId === 'default' && driverKind !== 'ari-core'
        ? null
        : (command.modelId ?? provider.defaultModelId ?? null)
    if (
      typeof command.effort === 'string' &&
      !(await offersEffort(driverKind, modelId, command.effort))
    ) {
      return {
        ok: false,
        code: 'unsupported_capability',
        message: 'this provider does not offer that effort level',
      }
    }

    const sessionId = deps.mintSessionId()
    const now = Date.now()
    await engine.createSession({
      id: sessionId,
      projectId: command.projectId,
      title: command.title ?? 'New session',
      driverKind,
      modelId,
      permissionMode: command.permissionMode ?? deps.defaultPermissionMode(),
      ...(command.effort === undefined ? {} : { effort: command.effort }),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true, result: { sessionId } }
  }
}

/**
 * The remote vocabulary mapped onto the engine's. Pure, and total over the
 * remote commands this host serves, so an operation added to the contract
 * without a mapping fails to compile rather than falling through at runtime.
 */
function commandToEngine(
  command: Exclude<
    RemoteCommand,
    {
      op:
        | 'session.create'
        | 'session.fork'
        | 'changes.integrate'
        | 'attachments.stage'
        | `terminal.${string}`
    }
  >,
  attachments: AttachmentRef[] = [],
): Command {
  switch (command.op) {
    case 'session.prompt':
      return {
        type: 'turn.start',
        sessionId: command.sessionId,
        text: command.text,
        attachments,
      }
    case 'session.queue':
      return {
        type: 'message.enqueue',
        sessionId: command.sessionId,
        text: command.text,
        attachments,
      }
    case 'session.steer':
      return {
        type: 'message.steer',
        sessionId: command.sessionId,
        text: command.text,
        attachments: [],
      }
    case 'session.interrupt':
      return { type: 'turn.interrupt', sessionId: command.sessionId }
    case 'session.archive':
      return { type: 'session.update', sessionId: command.sessionId, archived: true }
    case 'session.update':
      return {
        type: 'session.update',
        sessionId: command.sessionId,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.pinned === undefined ? {} : { pinned: command.pinned }),
        ...(command.modelId === undefined ? {} : { modelId: command.modelId }),
        ...(command.permissionMode === undefined ? {} : { permissionMode: command.permissionMode }),
        ...(command.effort === undefined ? {} : { effort: command.effort }),
      }
    case 'approval.respond':
      // The exact option the provider offered. Re-expanding a coarse kind here
      // would re-introduce the ambiguity P0 removed: two persistent grants can
      // share a kind, and only the id names one of them.
      return {
        type: 'approval.respond',
        sessionId: command.sessionId,
        approvalId: command.approvalId,
        optionId: command.optionId,
      }
    case 'input.respond':
      return {
        type: 'input.respond',
        sessionId: command.sessionId,
        inputId: command.inputId,
        value: command.value,
      }
    default: {
      const exhausted: never = command
      throw new Error(`no engine command for ${JSON.stringify(exhausted)}`)
    }
  }
}
