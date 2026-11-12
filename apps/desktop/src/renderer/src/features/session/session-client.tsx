import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { z } from 'zod'
import { rpcParams, type RpcMethod, type RpcResults, type SessionEventFrame } from '@ari/contracts/rpc'
import { attachmentRefSchema } from '@ari/contracts/attachments'
import { commandSchema } from '@ari/contracts/commands'
import { machineEventsFrameSchema } from '@ari/contracts/machines'
import {
  remoteQuerySchema, remoteDesktopQueryResultSchemas, remoteDesktopSessionResultSchema,
  remoteModelCatalogSchema, remoteAttachmentSchema, remoteFilesSchema, remoteFileSchema,
  remoteDesktopFrameSchema, remoteAllowanceSchema,
  type RemoteQuery, type RemoteModelCatalog,
} from '@ari/contracts/remote'
import { rpc as localRpc } from '../../lib/rpc'
import { remoteQuery, sendRemote, readReceipt, resolveReceipt, type RemoteAction, type RemoteReceipt } from '../machines/remote-client'
import { sessionViewKey, type SessionScope } from './session-scope'
import {
  assertMachineOperation, machineEpoch, sessionMachine, machineCapabilityReason,
  observeMachineInventory, machineInventoryRevision, refreshMachineInventory,
} from './session-machine-access'

export { sessionViewKey, parseSessionViewKey, type SessionScope } from './session-scope'

export type SessionAvailability = 'available' | 'offline' | 'incompatible' | 'revoked' | 'unavailable'
export interface SessionClient {
  readonly scope: SessionScope
  readonly viewKey: string
  readonly availability: SessionAvailability
  readonly readOnly: boolean
  readonly authorizationEpoch: number
  readonly invoke: typeof localRpc.invoke
  readonly subscribe: typeof localRpc.subscribe
  capabilityReason(operation: string): string | null
  receipt(scope?: string): RemoteReceipt | null
  checkReceipt(scope?: string): Promise<unknown>
  reconnect(): Promise<void>
  stageImages(files: File[]): Promise<z.infer<typeof attachmentRefSchema>[]>
}

const OPERATIONS: Partial<Record<RpcMethod, string>> = {
  'session.load': 'session.desktop.get', 'session.tasks': 'session.desktop.get',
  'session.resume.get': 'session.resume.get', 'session.resume.schedule': 'session.resume.schedule',
  'session.resume.cancel': 'session.resume.cancel', 'session.stopChildren': 'session.stopChildren',
  'providers.models': 'models.list', 'providers.efforts': 'models.efforts', 'providers.allowance': 'usage.allowance',
  'attachments.stage': 'attachments.stage', 'attachments.read': 'attachments.read',
  'files.index': 'files.index', 'fs.list': 'files.list', 'fs.readTextFile': 'files.read',
  'plan.get': 'plan.get', 'git.turnDiff': 'changes.turn', 'git.turnDiffFile': 'changes.turnFile',
  'scm.summary': 'scm.desktop.summary', 'scm.status': 'scm.desktop.status', 'scm.review': 'scm.desktop.review',
  'scm.diff': 'scm.desktop.diff',
}
const COMMAND_OPERATIONS: Record<string, string> = {
  'turn.start': 'session.prompt', 'message.enqueue': 'session.queue', 'message.steer': 'session.steer.attachments',
  'message.dequeue': 'session.dequeue', 'turn.interrupt': 'session.interrupt',
  'session.update': 'session.update', 'session.provider.switch': 'session.provider.switch',
  'approval.respond': 'approval.respond', 'input.respond': 'input.respond',
}
export function sessionOperation(method: string): string {
  return OPERATIONS[method as RpcMethod] ?? COMMAND_OPERATIONS[method] ?? method
}

/** An immutable host/session binding. Unsupported calls fail before reaching any local engine RPC. */
export function createSessionClient(requested: SessionScope): SessionClient {
  const scope = Object.freeze({ ...requested }) as SessionScope
  const viewKey = sessionViewKey(scope)
  if (scope.kind === 'local') {
    return {
      scope, viewKey, availability: 'available', readOnly: false, authorizationEpoch: 0,
      invoke: localRpc.invoke, subscribe: localRpc.subscribe, capabilityReason: () => null,
      receipt: () => null, checkReceipt: async () => { throw new Error('Local actions have no remote receipt.') },
      reconnect: async () => {},
      stageImages: async (files) => (await localRpc.invoke('attachments.stage', { files: await encodeImages(files) })).attachments,
    }
  }
  const { machineId, sessionId } = scope
  if (!machineId || !sessionId) throw new Error('A remote session requires an exact machine and session id.')
  const turnSnapshots = new Map<string, string>()
  const query = async (value: unknown): Promise<unknown> => {
    const parsed = remoteQuerySchema.parse(value)
    const epoch = await assertMachineOperation(machineId, parsed.op)
    const result = await remoteQuery(machineId, parsed)
    if (epoch !== machineEpoch(machineId)) throw new Error('Access changed while reading this session.')
    if (parsed.op in remoteDesktopQueryResultSchemas)
      return remoteDesktopQueryResultSchemas[parsed.op as keyof typeof remoteDesktopQueryResultSchemas].parse(result)
    return result
  }
  const act = async (action: RemoteAction): Promise<unknown> => {
    await assertMachineOperation(machineId, action.op)
    return sendRemote(machineId, 'sessionId' in action ? action.sessionId : sessionId, action)
  }
  const assertSession = (params: Record<string, unknown>): void => {
    if ('sessionId' in params && params.sessionId !== sessionId) throw new Error('This action belongs to another session.')
    if ('projectId' in params && params.projectId !== undefined) throw new Error('Remote session tools cannot use a client project root.')
  }
  const invoke = async <M extends RpcMethod>(method: M, raw?: unknown): Promise<RpcResults[M]> => {
    const p = (rpcParams[method].parse(raw) ?? {}) as Record<string, unknown>
    assertSession(p)
    let result: unknown
    switch (method) {
      case 'command.dispatch': {
        const command = commandSchema.parse(p.command)
        if (!('sessionId' in command) || command.sessionId !== sessionId) throw new Error('This command belongs to another session.')
        const op = COMMAND_OPERATIONS[command.type]
        if (!op) throw new Error('This control is unavailable on remote sessions.')
        const { type: _type, sessionId: _id, ...fields } = command
        const attachmentIds = 'attachments' in fields ? fields.attachments.map((ref) => ref.id) : undefined
        let action: unknown
        if (command.type === 'turn.start' || command.type === 'message.enqueue' || command.type === 'message.dequeue' || command.type === 'message.steer') {
          if (command.type === 'message.enqueue' && (command.hold || (command.priority && command.priority !== 'normal')))
            throw new Error('Remote delegated queue policy is unavailable.')
          action = { op, sessionId, text: command.text, attachmentIds }
        } else {
          if (command.type === 'session.update' && (command.driverKind !== undefined || command.archived !== undefined))
            throw new Error('Use the supported provider switch; remote session administration is unavailable.')
          if (command.type === 'approval.respond' && (!command.optionId || command.decision !== undefined))
            throw new Error('Select the exact host approval option.')
          if (command.type === 'input.respond' && command.expectedTurnId !== undefined)
            throw new Error('This host does not support fenced coordination answers.')
          action = { op, sessionId, ...fields }
        }
        result = await act(action as RemoteAction)
        break
      }
      case 'session.load':
      case 'session.tasks': {
        const metadata = remoteDesktopSessionResultSchema.parse(await query({ op: 'session.desktop.get', sessionId }))
        if (metadata.session.id !== sessionId || metadata.summary.id !== sessionId) throw new Error('The host returned another session.')
        result = method === 'session.tasks' ? metadata.tasks ?? [] : {
          ...metadata, activeTurnId: metadata.liveTurnId,
          // A boolean context marker is sufficient; native provider identifiers never cross the wire.
          hasProviderContext: metadata.context.hasProviderContext,
        }
        break
      }
      case 'session.resume.get': case 'plan.get':
        result = await query({ op: method, sessionId }); break
      case 'session.resume.schedule': case 'session.resume.cancel': case 'session.stopChildren':
        result = await act({ ...p, op: method, sessionId } as RemoteAction); break
      case 'attachments.read':
        result = remoteAttachmentSchema.parse(await query({ op: 'attachments.read', sessionId, attachmentId: p.id })); break
      case 'attachments.stage': {
        const attachments = []
        for (const file of p.files as Record<string, unknown>[]) {
          const staged = z.object({ attachments: attachmentRefSchema.array() }).parse(await act({ op: 'attachments.stage', sessionId, files: [file] } as RemoteAction))
          attachments.push(...staged.attachments)
        }
        result = { attachments }; break
      }
      case 'providers.models': {
        const catalog = remoteModelCatalogSchema.parse(await query({ op: 'models.list' }))
        result = catalog.providers.map((provider) => ({ kind: provider.driverKind, ...provider })); break
      }
      case 'providers.efforts':
        result = await query({ op: 'models.efforts', driverKind: p.kind, ...(p.modelId ? { modelId: p.modelId } : {}) }); break
      case 'providers.allowance': {
        const allowance = remoteAllowanceSchema.parse(await query({ op: 'usage.allowance', driverKind: p.kind }))
        result = { kind: allowance.driverKind, ...allowance, checkedAt: Date.now(), detail: '', resetCredits: { availableCount: allowance.bankedResets, nextExpiresAt: null } }; break
      }
      case 'files.index': {
        const paths: string[] = []
        let cursor: string | undefined
        do {
          const page = remoteDesktopQueryResultSchemas['files.index'].parse(await query({ op: 'files.index', sessionId, cursor, limit: 200 }))
          paths.push(...page.paths)
          if (page.nextCursor === cursor) throw new Error('The host repeated a file cursor.')
          cursor = page.nextCursor ?? undefined
        } while (cursor && paths.length < 20000)
        result = { paths }; break
      }
      case 'fs.list': {
        const files = remoteFilesSchema.parse(await query({ op: 'files.list', sessionId, path: p.path ?? '', limit: 200 }))
        if (files.error || files.nextCursor) throw new Error(files.error ?? 'This directory is too large to list completely.')
        result = files.entries.map((entry) => ({ name: entry.name, type: entry.kind === 'directory' ? 'dir' : 'file', size: entry.size ?? 0 })); break
      }
      case 'fs.readTextFile': {
        const file = remoteFileSchema.parse(await query({ op: 'files.read', sessionId, path: p.path }))
        if (file.error || file.kind !== 'text' || file.content === null) throw new Error(file.error ?? 'This host file cannot be displayed as text.')
        result = { content: file.content, truncated: false }; break
      }
      case 'git.turnDiff': {
        result = await query({ op: 'changes.turn', sessionId, turnId: p.turnId })
        const summary = (result as { summary?: { baseOid: string; headOid: string } }).summary
        if (summary) turnSnapshots.set(JSON.stringify([summary.baseOid, summary.headOid]), p.turnId as string)
        break
      }
      case 'git.turnDiffFile': {
        const turnId = turnSnapshots.get(JSON.stringify([p.baseOid, p.headOid]))
        if (!turnId) throw new Error('Reload the host turn summary before opening this file.')
        result = await query({ op: 'changes.turnFile', sessionId, turnId, path: p.path }); break
      }
      case 'scm.summary': case 'scm.status':
        result = await query({ op: OPERATIONS[method], sessionId }); break
      case 'scm.review':
        result = await query({ op: 'scm.desktop.review', sessionId, comparison: p.comparison }); break
      case 'scm.diff':
        result = await query({ op: 'scm.desktop.diff', sessionId, snapshotId: p.snapshotId, path: p.path, context: p.context }); break
      case 'scm.cancel': result = { cancelled: true }; break
      default: throw new Error(`This host does not support ${method}.`)
    }
    return result as RpcResults[M]
  }
  const client: SessionClient = {
    scope, viewKey, invoke,
    get authorizationEpoch() { return machineEpoch(machineId) },
    get availability() {
      const machine = sessionMachine(machineId)
      if (!machine) return 'unavailable'
      return machine.status === 'connected' ? 'available' : machine.status === 'incompatible' ? 'incompatible' :
        machine.status === 'revoked' || machine.status === 'unpaired' ? 'revoked' : 'offline'
    },
    get readOnly() { return client.availability !== 'available' || client.capabilityReason('events.desktop.subscribe') !== null },
    capabilityReason(operation) { return machineCapabilityReason(sessionMachine(machineId), sessionOperation(operation)) },
    receipt(receiptScope = sessionId) { return readReceipt(machineId, receiptScope) },
    async checkReceipt(receiptScope = sessionId) {
      await assertMachineOperation(machineId, 'command.status')
      return resolveReceipt(machineId, receiptScope)
    },
    async reconnect() { await localRpc.invoke('machines.connect', { machineId }); await refreshMachineInventory() },
    async stageImages(files) { return (await invoke('attachments.stage', { files: await encodeImages(files) })).attachments },
    subscribe(name, params, onEvent) {
      if (name !== 'session.events') return () => {}
      assertSession(params)
      let closed = false
      let stopStream: (() => void) | null = null
      let mode: 'full' | 'resume' = 'full'
      let started = false
      const finishUnavailable = () => onEvent({ sessionId, replayDone: true, replayOutcome: 'incomplete', liveTurnId: null } satisfies SessionEventFrame)
      void assertMachineOperation(machineId, 'events.desktop.subscribe').then((epoch) => {
        if (closed) return
        stopStream = localRpc.subscribe('machines.events', { machineId, sessionId, desktop: true, ...('fromSeq' in params ? { fromSeq: params.fromSeq } : {}) }, (raw) => {
          if (closed || epoch !== machineEpoch(machineId)) return
          const envelope = machineEventsFrameSchema.safeParse(raw)
          if (!envelope.success || envelope.data.machineId !== machineId) return
          const message = envelope.data.message
          if (message.type === 'error' || message.type === 'events.desync') { finishUnavailable(); return }
          const parsed = remoteDesktopFrameSchema.safeParse(message)
          if (!parsed.success || parsed.data.sessionId !== sessionId) return
          const frame = parsed.data.frame
          switch (frame.kind) {
            case 'start': mode = frame.replayMode; started = true; break
            case 'chunk':
              if (started && frame.events.every((event) => event.sessionId === sessionId))
                onEvent({ sessionId, events: frame.events, replay: true, replayMode: mode })
              break
            case 'terminal':
              if (started) onEvent({ sessionId, replayDone: true, replayOutcome: frame.replayOutcome, liveTurnId: frame.liveTurnId, replayMode: mode, seq: frame.seq })
              break
            case 'live':
              if (frame.event.sessionId === sessionId) onEvent({ sessionId, event: frame.event })
              break
          }
        })
      }).catch(() => { if (!closed) finishUnavailable() })
      return () => { closed = true; stopStream?.() }
    },
  }
  return client
}

export async function encodeImages(files: File[]): Promise<{ name: string; mimeType: string; dataBase64: string }[]> {
  return Promise.all(files.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { name: file.name, mimeType: file.type, dataBase64: btoa(binary) }
  }))
}

const Context = createContext<SessionClient | null>(null)
// Outside a session, the normal tools explicitly operate on local project roots.
const localProjectClient = createSessionClient({ kind: 'local', sessionId: '' })
export function SessionClientProvider({ scope, client: supplied, children }: {
  scope?: SessionScope; client?: SessionClient; children: ReactNode
}) {
  const client = useMemo(() => supplied ?? (scope ? createSessionClient(scope) : null), [supplied, scope?.kind, scope?.sessionId, scope?.kind === 'remote' ? scope.machineId : null])
  if (!client) throw new Error('SessionClientProvider requires an explicit scope or client.')
  useSyncExternalStore(client.scope.kind === 'remote' ? observeMachineInventory : () => () => {}, machineInventoryRevision)
  return <Context.Provider value={client}>{children}</Context.Provider>
}
export function useSessionClient(): SessionClient { return useContext(Context) ?? localProjectClient }
export async function readHostModelCatalog(machineId: string): Promise<RemoteModelCatalog> {
  await assertMachineOperation(machineId, 'models.list')
  return remoteModelCatalogSchema.parse(await remoteQuery(machineId, { op: 'models.list' } satisfies RemoteQuery))
}
