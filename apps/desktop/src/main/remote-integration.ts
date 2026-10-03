import { ControlFailure } from '@ari/contracts/agent-control'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import type { Session } from '@ari/contracts/session'
import type { RemoteIntegrationPreview } from '@ari/contracts/remote'
import type { ManagedWorkspaces } from '@ari/engine/git'
import type { SessionStore } from '@ari/engine/session-store'
import type { Engine } from './engine'

/** Reviewed, idle managed-child integration using the engine's non-destructive Git snapshots. */
export class RemoteIntegration {
  readonly #locks = new Set<string>()
  constructor(
    readonly workspaces: ManagedWorkspaces,
    readonly engine: Pick<Engine, 'workspace' | 'quiesce' | 'hasLiveTurn' | 'record'>,
    readonly store: SessionStore,
  ) {}

  async #pair(
    caller: RemoteCaller,
    sessionId: string,
  ): Promise<{ child: Session; parent: Session; cwd: string }> {
    const child = (await this.store.load(sessionId)).session
    if (!child || !caller.projectIds.includes(child.projectId))
      throw new ControlFailure('scope_denied', 'No such session.')
    if (!child.parentSessionId || child.workspace?.kind !== 'managed-worktree')
      throw new ControlFailure('scope_denied', 'Only isolated child sessions can be integrated.')
    const parent = (await this.store.load(child.parentSessionId)).session
    if (
      !parent ||
      !caller.projectIds.includes(parent.projectId) ||
      parent.projectId !== child.projectId
    )
      throw new ControlFailure('scope_denied', 'Parent session is unavailable.')
    await this.#idle(child.id, parent.id)
    const cwd = await this.engine.workspace(parent)
    if (!cwd)
      throw new ControlFailure('managed_worktree_missing', 'Parent workspace is unavailable.')
    return { child, parent, cwd }
  }

  async #idle(...ids: string[]): Promise<void> {
    for (const id of ids) {
      if ((await this.store.load(id)).activeTurnId || this.engine.hasLiveTurn(id))
        throw new ControlFailure(
          'invalid_request',
          'Wait for both sessions to finish running before integrating.',
        )
      await this.engine.quiesce(id)
      if ((await this.store.load(id)).activeTurnId || this.engine.hasLiveTurn(id))
        throw new ControlFailure(
          'invalid_request',
          'A session started another turn. Wait and review again.',
        )
    }
  }

  async preview(caller: RemoteCaller, sessionId: string): Promise<RemoteIntegrationPreview> {
    const { child, parent, cwd } = await this.#pair(caller, sessionId)
    const diff = await this.workspaces.diff(child, false)
    const expectedParentSnapshot = await this.workspaces.snapshot(
      cwd,
      `refs/ari/orchestration/${parent.id}/remote-preview`,
    )
    await this.#idle(child.id, parent.id)
    return {
      sessionId,
      parentSessionId: parent.id,
      snapshotCommit: diff.currentSnapshotCommit,
      expectedParentSnapshot,
      files: diff.files,
    }
  }

  async integrate(
    caller: RemoteCaller,
    sessionId: string,
    snapshot: string,
    expectedParentSnapshot: string,
  ): Promise<unknown> {
    const { child, parent, cwd } = await this.#pair(caller, sessionId)
    if (this.#locks.has(parent.id))
      throw new ControlFailure(
        'invalid_request',
        'Another integration is in progress. Review again when it finishes.',
      )
    this.#locks.add(parent.id)
    try {
      const records = ((await this.store.load(parent.id)).childEvents ?? []).filter(
        (event) =>
          event.type === 'child.session.integrated' &&
          event.childSessionId === child.id &&
          event.result === 'integrated',
      )
      if (
        records.some(
          (event) => event.type === 'child.session.integrated' && event.snapshotCommit === snapshot,
        )
      )
        return { status: 'already_integrated', snapshotCommit: snapshot }
      if ((await this.workspaces.currentSnapshot(child)) !== snapshot)
        throw new ControlFailure(
          'stale_snapshot',
          'Child files changed after preview. Review a fresh preview.',
        )
      await this.#idle(child.id, parent.id)
      const previous = records.at(-1)
      const result = await this.workspaces.integrate(
        parent,
        cwd,
        child,
        snapshot,
        previous?.type === 'child.session.integrated' ? previous.snapshotCommit : undefined,
        expectedParentSnapshot,
      )
      const event = {
        type: 'child.session.integrated' as const,
        childSessionId: child.id,
        snapshotCommit: snapshot,
        result: result.status,
        conflictFiles: result.status === 'conflict' ? result.files : [],
      }
      await this.engine.record(parent.id, event)
      return result
    } finally {
      this.#locks.delete(parent.id)
    }
  }
}
