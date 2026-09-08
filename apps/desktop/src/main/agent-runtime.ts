import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ControlFailure, type DelegationSettings } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { AgentControlService, type ControlHost } from '@ari/engine/agent-control'
import { AgentControlServer } from '@ari/engine/control-server'
import { ManagedWorkspaces } from '@ari/engine/git'
import type { SessionStore } from '@ari/engine/session-store'
import type { Engine } from './engine'
import { DelegationApprovals } from './delegation-approvals'

const scopedKeys = [
  'ARI_ENV',
  'ARI_SESSION_ID',
  'ARI_PROJECT_ID',
  'ARI_PARENT_SESSION_ID',
  'ARI_CONTROL_ENDPOINT',
  'ARI_CONTROL_TOKEN',
  'ARI_CLI',
]

export interface AgentRuntimeOptions {
  userData: string
  cliPath: string
  executable: string
  version: string
  engine: Engine
  store: SessionStore
  policy(): DelegationSettings
  providers: ControlHost['providers']
  baseEnv?: NodeJS.ProcessEnv
}

/** Hosts the transport and injects private CLI launchers without changing global PATH. */
export async function startAgentRuntime(options: AgentRuntimeOptions) {
  const { engine, store } = options
  const runtimeDir = join(options.userData, 'agent-control')
  const bin = join(runtimeDir, 'bin')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ari-${randomUUID()}`
      : join(runtimeDir, `${randomUUID()}.sock`)
  const launcher = join(bin, process.platform === 'win32' ? 'ari.cmd' : 'ari')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const script =
    process.platform === 'win32'
      ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${options.executable.replaceAll('%', '%%')}" "${options.cliPath.replaceAll('%', '%%')}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(options.executable)} ${quote(options.cliPath)} "$@"\n`
  await writeFile(launcher, script, 'utf8')
  if (process.platform !== 'win32') await chmod(launcher, 0o700)
  const workspaces = new ManagedWorkspaces(join(options.userData, 'worktrees'))
  const approvals = new DelegationApprovals(engine)
  const workspace = async (session: Session): Promise<string> => {
    const cwd = await engine.workspace(session)
    if (!cwd)
      throw new ControlFailure('managed_worktree_missing', 'Session workspace is unavailable.')
    return cwd
  }
  let dropSession = (id: string): void => {
    approvals.cancel(id)
  }
  const service = new AgentControlService({
    store,
    version: options.version,
    policy: () => options.policy(),
    providers: options.providers,
    create: (session) => engine.createSession(session),
    dispatch: (command, origin) => engine.dispatch(command, origin),
    record: (id, event) => engine.record(id, event),
    subscribe: (listener) => store.subscribe(listener),
    workspace,
    isRunning: (id) => engine.hasLiveTurn(id),
    isolate: async (parent, id) => workspaces.isolate(parent, await workspace(parent), id),
    diff: async (child, patch) => {
      await engine.quiesce(child.id)
      if ((await store.load(child.id)).activeTurnId || engine.hasLiveTurn(child.id))
        throw new ControlFailure(
          'invalid_request',
          'Child started another turn; wait before inspecting changes.',
        )
      return workspaces.diff(child, patch)
    },
    integrate: async (parent, child, snapshot, options) => {
      await engine.quiesce(child.id)
      if ((await store.load(child.id)).activeTurnId || engine.hasLiveTurn(child.id))
        throw new ControlFailure(
          'invalid_request',
          'Child started another turn; wait before integrating.',
        )
      if (!options?.allowStale) {
        const current = await workspaces.currentSnapshot(child)
        if (current !== snapshot)
          throw new ControlFailure(
            'stale_snapshot',
            'Snapshot is not the current child snapshot. Pass allowStale to integrate a historical snapshot.',
          )
      }
      const model = await store.load(parent.id)
      const records = (model.childEvents ?? []).filter(
        (e) =>
          e.type === 'child.session.integrated' &&
          e.childSessionId === child.id &&
          e.result === 'integrated',
      )
      if (
        records.some((e) => e.type === 'child.session.integrated' && e.snapshotCommit === snapshot)
      )
        return { status: 'already_integrated', snapshotCommit: snapshot }
      const previous = records.at(-1)
      const result = await workspaces.integrate(
        parent,
        await workspace(parent),
        child,
        snapshot,
        previous?.type === 'child.session.integrated' ? previous.snapshotCommit : undefined,
      )
      const event = {
        type: 'child.session.integrated' as const,
        childSessionId: child.id,
        snapshotCommit: snapshot,
        result: result.status,
        conflictFiles: result.status === 'conflict' ? result.files : [],
      }
      try {
        await engine.record(parent.id, event)
      } catch {
        await engine.record(parent.id, event)
      }
      return result
    },
    approve: (root) => approvals.request(root, options.policy().maxConcurrentChildren),
    quiesce: (id) => engine.quiesce(id),
    revoke: (id) => dropSession(id),
    release: async (child) => {
      await workspaces.release(child.id)
      dropSession(child.id)
    },
  })
  const server = new AgentControlServer({
    endpoint,
    invoke: (caller, method, params, signal) => service.invoke(caller, method, params, signal),
  })
  dropSession = (id) => {
    approvals.cancel(id)
    server.revoke(id)
  }
  await server.listen()
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'turn.settled') approvals.cancel(event.sessionId)
  })
  return {
    service,
    approvals,
    authorizeTurn: async (session: Session): Promise<string | null> => {
      if (!session.parentSessionId) return null
      if (session.archived) return 'Restore the child session before starting a turn.'
      const policy = options.policy()
      let active = 0
      for (const row of await store.listSessions()) {
        if (
          row.id !== session.id &&
          row.parentSessionId &&
          row.rootSessionId === session.rootSessionId &&
          ((await store.load(row.id)).activeTurnId || engine.hasLiveTurn(row.id))
        )
          active++
      }
      return active >= policy.maxConcurrentChildren
        ? 'Maximum concurrent child sessions reached.'
        : null
    },
    revoke: (id: string) => dropSession(id),
    release: async (id: string) => {
      await workspaces.release(id)
      dropSession(id)
    },
    close: async () => {
      unsubscribe()
      approvals.close()
      await server.close()
    },
    environment: (session: Session): NodeJS.ProcessEnv => {
      const env = { ...(options.baseEnv ?? process.env) }
      for (const key of scopedKeys) env[key] = undefined
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
      const inheritedPath = env[pathKey] ?? ''
      delete env[pathKey]
      return {
        ...env,
        PATH: `${bin}${delimiter}${inheritedPath}`,
        ARI_ENV: '1',
        ARI_SESSION_ID: session.id,
        ARI_PROJECT_ID: session.projectId,
        ARI_PARENT_SESSION_ID: session.parentSessionId ?? undefined,
        ARI_CONTROL_ENDPOINT: endpoint,
        ARI_CONTROL_TOKEN: server.tokenFor(session.id),
        ARI_CLI: launcher,
      }
    },
  }
}
