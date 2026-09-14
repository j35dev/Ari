import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import type { Message } from '@ari/contracts/message'
import type { RemoteCommand, RemoteOperation } from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { RemoteCaller, RemoteHost } from '@ari/remote-gateway/host'
import type { PairingService } from '@ari/remote-gateway/pairing'
import type { Engine } from './engine'
import type { SessionStore } from '@ari/engine/session-store'

/**
 * The desktop's implementation of the gateway's port.
 *
 * Everything a remote client can reach goes through here, and what it can
 * reach is the list in {@linkcode OPERATIONS} — not the RPC surface the
 * renderer uses. There is no path from this file to a terminal, a shell, a
 * provider login, an arbitrary file read, or the agent-to-agent control socket.
 *
 * Two rules shape every method below:
 *
 * A device sees only the projects the user granted it at pairing. The check is
 * on the session's own `projectId` read from the journal, never on a project id
 * the caller supplied, so a device cannot name its way into someone else's
 * session.
 *
 * And the desktop's permission ceiling is authoritative. A remote client has no
 * way to name a permission mode — the strict command envelope has no such field
 * — so a session created from a phone inherits the user's configured default.
 */

export interface RemoteHostDeps {
  engine: Engine
  store: SessionStore
  /** Providers this desktop can actually drive right now. */
  driverKinds: readonly DriverKind[]
  /**
   * The ceiling for a session the caller did not explicitly configure. Read at
   * call time rather than captured, so changing the setting takes effect
   * without restarting the gateway.
   */
  defaultPermissionMode: () => PermissionMode
  /** Provider for a session created from a phone, when the user has a default. */
  defaultDriverKind: () => DriverKind | null
  /** Whether a project id names a project on this machine. */
  hasProject: (projectId: string) => Promise<boolean>
  /** Owns the device records `device.list` and `device.revoke` read and write. */
  pairing: PairingService
  mintSessionId: () => string
}

/**
 * What this host serves today. Notably absent: `changes.files`, `changes.diff`
 * and `changes.integrate`. Nothing in the desktop produces a per-file change
 * list for a session yet, and the only `integrate` that exists is the
 * agent-to-agent delegation one, which ADR §19 keeps off this surface. They are
 * absent here rather than refused at call time, so a client learns what is
 * possible from `gateway.info` instead of from a failure.
 */
const OPERATIONS: readonly RemoteOperation[] = [
  'session.list',
  'session.get',
  'session.create',
  'session.archive',
  'session.prompt',
  'session.queue',
  'session.steer',
  'session.interrupt',
  'approval.respond',
  'input.respond',
  'events.subscribe',
  'device.list',
  'device.revoke',
]

export function createRemoteHost(deps: RemoteHostDeps): RemoteHost {
  const { store, engine, pairing } = deps

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
    | { session: Session; summary: SessionSummary; seq: number; messages: Message[] }
    | undefined
  > {
    const { session, messages, lastSeq } = await store.load(sessionId)
    if (session === null || !granted(caller, session.projectId)) return undefined
    const summary = (await listSessions(caller)).find((entry) => entry.id === sessionId)
    if (summary === undefined) return undefined
    // The state and the journal high-water mark it was taken at travel
    // together, so a subscriber resuming from `seq` sees no gap and no repeat.
    return { session, summary, seq: lastSeq, messages }
  }

  return {
    capabilities: () => OPERATIONS,
    listSessions,
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
      // Declared by the contract but not served here, so it is also absent from
      // OPERATIONS. Refused explicitly as well: the only integration the
      // desktop has is the agent-to-agent delegation one, which ADR §19 keeps
      // off this surface, and adding the capability without an implementation
      // must not fall through to something that looks like success.
      return {
        ok: false,
        code: 'unsupported_capability',
        message: 'integrating changes is not available on this desktop',
      }
    }

    const session = await visible(caller, command.sessionId)
    if (session === undefined) {
      return { ok: false, code: 'not_found', message: 'no such session' }
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
    const driverKind = command.driverKind ?? deps.defaultDriverKind()
    if (driverKind === null || !deps.driverKinds.includes(driverKind)) {
      return {
        ok: false,
        code: 'unsupported_capability',
        message: 'this desktop cannot run that provider',
      }
    }

    const sessionId = deps.mintSessionId()
    const now = Date.now()
    await engine.createSession({
      id: sessionId,
      projectId: command.projectId,
      title: command.title ?? 'New session',
      driverKind,
      modelId: command.modelId ?? null,
      // Never from the client: the envelope cannot carry a permission mode, and
      // this is the ceiling the user set at the desktop.
      permissionMode: deps.defaultPermissionMode(),
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
  command: Exclude<RemoteCommand, { op: 'session.create' | 'changes.integrate' }>,
): Command {
  switch (command.op) {
    case 'session.prompt':
      // Attachments are not on this surface: there is no upload route, so an
      // id could come from nowhere the desktop can verify.
      return {
        type: 'turn.start',
        sessionId: command.sessionId,
        text: command.text,
        attachments: [],
      }
    case 'session.queue':
      return {
        type: 'message.enqueue',
        sessionId: command.sessionId,
        text: command.text,
        attachments: [],
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
