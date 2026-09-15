import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind } from '@ari/contracts/common'
import type { RemoteApproval, RemoteCommand, RemoteInput, RemoteOperation, RemoteProject } from '@ari/contracts/remote'

/**
 * The authenticated device a call is made on behalf of.
 *
 * Every method below takes one, because authorization without a subject is not
 * authorization. A device is approved for a named set of projects, and the
 * host — not the gateway — is where that set is enforced: the gateway knows
 * which device is calling, but only the host knows what a session's `projectId`
 * means and whether this device was granted it.
 */
export interface RemoteCaller {
  deviceId: string
  /** Projects the user granted at pairing. Empty grants nothing. */
  projectIds: readonly string[]
}

/**
 * The gateway's view of the desktop.
 *
 * This is the whole of what a remote client can reach, and it is deliberately
 * narrower than the RPC surface the renderer uses: there is no method here for
 * opening a terminal, running a shell, logging a provider in, reading an
 * arbitrary path, or writing a file. The gateway cannot call what this
 * interface does not declare, so the restriction survives a careless handler
 * rather than depending on one.
 *
 * `apps/desktop/src/main` supplies the implementation over the existing
 * `Engine`; tests supply a fake. Nothing here reaches the agent-to-agent
 * control socket (ADR §19).
 */
export interface RemoteHost {
  /**
   * Which operations this host can actually serve right now. Operations tied
   * to a provider or to a session's state are absent when unavailable, so a
   * client learns what is possible instead of inferring it from a name and
   * being refused later.
   */
  capabilities(): readonly RemoteOperation[]

  listSessions(caller: RemoteCaller): Promise<SessionSummary[]>

  /**
   * The projects this device was granted, as the desktop names them. Names and
   * ids only: a phone starts work in a project by naming it, and a filesystem
   * path is neither useful there nor safe to hand out.
   */
  listProjects(caller: RemoteCaller): Promise<RemoteProject[]>

  /**
   * One session's projected state plus the journal high-water mark it was
   * taken at. The two travel together so a subscriber can resume from exactly
   * this point and see no gap and no duplicate. `undefined` covers both a
   * session that does not exist and one this device was not granted — the two
   * are not distinguished on the wire, because telling a device that a session
   * exists but is someone else's is itself a disclosure.
   *
   * What is waiting on a human rides along, because a client that opens a
   * session while an approval is already pending never saw the event that
   * announced it: without this it renders an idle session while the agent sits
   * blocked, which is the one state a remote control surface must not show.
   */
  getSession(
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
  >

  /**
   * Replays a session's journal after `fromSeq`. Returns `undefined` when the
   * journal cannot be replayed from there — the gateway then says so and the
   * client re-snapshots rather than silently missing events.
   */
  replay(caller: RemoteCaller, sessionId: string, fromSeq: number): Promise<JournalEvent[] | undefined>

  /**
   * Runs a validated command. The gateway has already checked the operation is
   * declared, the caller is paired, the origin is allowed, and the idempotency
   * key is fresh; the host performs the effect and returns what to record.
   */
  execute(
    caller: RemoteCaller,
    command: RemoteCommand,
  ): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }>

  /** Projected state for a query operation. */
  query(caller: RemoteCaller, op: RemoteOperation, params: Record<string, unknown>): Promise<unknown>

  /**
   * Subscribes to a session's live events. Returns an unsubscribe function.
   * The gateway bounds its buffer; a consumer that falls too far behind is
   * disconnected rather than allowed to grow the gateway's memory.
   */
  subscribe(
    caller: RemoteCaller,
    sessionId: string,
    onEvent: (event: JournalEvent) => void,
  ): () => void
}

/** What the desktop tells the gateway at construction. */
export interface RemoteHostOptions {
  /** Exact origins allowed to call. Never a wildcard. */
  allowedOrigins: readonly string[]
  /** Providers this host can drive, for capability reporting. */
  driverKinds: readonly DriverKind[]
}

/** A creation request the gateway passes through after validation. */
export interface CreateSessionRequest {
  projectId: string
  title?: string
  driverKind?: DriverKind
  modelId?: string
}
