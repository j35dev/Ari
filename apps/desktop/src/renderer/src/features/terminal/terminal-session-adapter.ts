import { z } from 'zod'
import { rpcParams, type RpcMethod, type RpcResults } from '@ari/contracts/rpc'
import { remoteTerminalSchema, type RemoteQuery } from '@ari/contracts/remote'
import type { SessionClient } from '../session/session-client'
import {
  assertMachineOperation,
  machineEpoch,
  sessionMachine,
} from '../session/session-machine-access'
import {
  readReceipt,
  remoteQuery,
  resolveReceipt,
  sendRemote,
  type RemoteAction,
} from '../machines/remote-client'
import {
  bindRemoteTerminalTab,
  findTerminalTab,
  markRemoteTerminalCreation,
  terminalOwnerKey,
  type TerminalOwner,
} from './terminal-dock'

const created = z.object({ terminalId: z.string().min(1).max(128) })
const queues = new Map<string, Promise<unknown>>()

/** Adds host-owned pty operations to the same typed client used by normal tools. */
export function createTerminalSessionAdapter(client: SessionClient) {
  if (client.scope.kind === 'local')
    return { ...client, checkTerminal: (_id: string) => Promise.resolve(undefined) }
  const { machineId, sessionId } = client.scope
  const owner: Extract<TerminalOwner, { kind: 'remote' }> = { kind: 'remote', machineId, sessionId }
  const receiptScope = (id: string) => `terminal:${sessionId}:${id}`
  const tab = (id: string) => {
    const value = findTerminalTab(id)
    if (
      !value ||
      value.owner?.kind !== 'remote' ||
      terminalOwnerKey(value.owner) !== terminalOwnerKey(owner)
    )
      throw new Error('This terminal belongs to another machine or session.')
    return value
  }
  const guard = async (operation: string): Promise<number> => {
    if (client.readOnly) throw new Error('Reconnect this session to use its terminal.')
    const epoch = await assertMachineOperation(machineId, operation)
    if (client.readOnly || sessionMachine(machineId)?.allowTerminal !== true)
      throw new Error('Terminal access must be granted on the owning machine.')
    return epoch
  }
  const bind = (id: string, result: unknown) =>
    bindRemoteTerminalTab(id, owner, created.parse(result).terminalId)
  const checkTerminal = async (id: string): Promise<void> => {
    tab(id)
    await guard('command.status')
    const receipt = readReceipt(machineId, receiptScope(id))
    if (receipt) {
      await resolveReceipt(
        machineId,
        receiptScope(id),
        false,
        receipt.command.op === 'terminal.create' ? (result) => bind(id, result) : undefined,
      )
    } else if (!tab(id).hostTerminalId && tab(id).creationAttempted)
      throw new Error(
        'The shell creation outcome is unknown. Inspect the host before opening another shell.',
      )
  }
  const execute = async (method: RpcMethod, p: Record<string, unknown>): Promise<unknown> => {
    const id = z.string().parse(p.id)
    const current = tab(id)
    if (method === 'terminal.create') {
      await guard('terminal.create')
      if (current.hostTerminalId) return undefined
      if (readReceipt(machineId, receiptScope(id))) {
        await checkTerminal(id)
        return undefined
      }
      if (!markRemoteTerminalCreation(id, owner))
        throw new Error(
          'The shell creation outcome is unknown. Check its original receipt; it will not be sent again.',
        )
      await sendRemote(
        machineId,
        receiptScope(id),
        { op: 'terminal.create', sessionId, cols: 80, rows: 24 },
        (result) => bind(id, result),
      )
      return undefined
    }
    if (!current.hostTerminalId) {
      if (
        method === 'terminal.kill' &&
        !current.creationAttempted &&
        !readReceipt(machineId, receiptScope(id))
      )
        return undefined
      throw new Error('Check the original shell creation receipt before using this terminal.')
    }
    const op = method as 'terminal.write' | 'terminal.resize' | 'terminal.kill'
    await guard(op)
    if (readReceipt(machineId, receiptScope(id)))
      throw new Error(
        'Check the unconfirmed terminal action before continuing. It will not be sent again.',
      )
    const action =
      method === 'terminal.write'
        ? { op, sessionId, terminalId: current.hostTerminalId, data: p.data }
        : method === 'terminal.resize'
          ? {
              op,
              sessionId,
              terminalId: current.hostTerminalId,
              cols: Math.max(20, Math.min(300, p.cols as number)),
              rows: Math.max(5, Math.min(100, p.rows as number)),
            }
          : { op, sessionId, terminalId: current.hostTerminalId }
    await sendRemote(machineId, receiptScope(id), action as RemoteAction)
    return undefined
  }
  const invoke: SessionClient['invoke'] = async <M extends RpcMethod>(
    method: M,
    raw?: unknown,
  ): Promise<RpcResults[M]> => {
    if (!['terminal.create', 'terminal.write', 'terminal.resize', 'terminal.kill'].includes(method))
      return client.invoke(method, raw)
    const p = rpcParams[method].parse(raw) as Record<string, unknown>
    const id = z.string().parse(p.id)
    tab(id)
    const key = JSON.stringify([machineId, sessionId, id])
    const previous = queues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(() => execute(method, p))
    queues.set(key, result)
    void result
      .finally(() => {
        if (queues.get(key) === result) queues.delete(key)
      })
      .catch(() => undefined)
    return await result
  }
  const subscribe: SessionClient['subscribe'] = (name, params, onEvent) => {
    if (name !== 'terminal.data') return client.subscribe(name, params, onEvent)
    const id = z.string().parse(params.id)
    tab(id)
    let closed = false
    let reading = false
    let cursor = 0
    const read = async () => {
      if (closed || reading) return
      reading = true
      try {
        if (!tab(id).hostTerminalId) return
        const epoch = await guard('terminal.read')
        for (let i = 0; i < 4 && !closed; i++) {
          const hostTerminalId = tab(id).hostTerminalId!
          const query = {
            op: 'terminal.read',
            sessionId,
            terminalId: hostTerminalId,
            fromSeq: cursor,
          } satisfies RemoteQuery
          const page = remoteTerminalSchema.parse(await remoteQuery(machineId, query))
          if (
            closed ||
            epoch !== machineEpoch(machineId) ||
            sessionMachine(machineId)?.allowTerminal !== true
          )
            return
          if (
            page.terminalId !== hostTerminalId ||
            page.error ||
            (!page.reset && page.seq < cursor)
          )
            throw new Error(page.error ?? 'The host returned an invalid terminal frame.')
          onEvent({ id, data: page.data, reset: page.reset, exited: page.exited })
          cursor = page.seq
          if (!page.hasMore || page.exited) break
        }
      } catch (error) {
        if (!closed)
          onEvent({
            id,
            data: '',
            error: error instanceof Error ? error.message : 'The host terminal is unavailable.',
          })
        closed = true
      } finally {
        reading = false
      }
    }
    const timer = setInterval(() => {
      void read()
    }, 700)
    void read()
    return () => {
      closed = true
      clearInterval(timer)
    }
  }
  return { ...client, invoke, subscribe, checkTerminal }
}
