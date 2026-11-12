import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readReceipt, remoteQuery, resolveReceipt, sendRemote } from './remote-client'
import { readRemoteDraft, writeRemoteDraft } from './remote-drafts'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

describe('remote host ownership and receipts', () => {
  beforeEach(() => {
    localStorage.clear()
    invoke.mockReset()
  })
  it('preserves drafts with identical session IDs on different hosts', () => {
    writeRemoteDraft('host-a', 'same', {
      text: 'A',
      attachments: [{ id: 'image-a', name: 'a.png', mimeType: 'image/png', size: 3 }],
    })
    writeRemoteDraft('host-b', 'same', { text: 'B', attachments: [] })
    expect(readRemoteDraft('host-a', 'same').attachments[0]?.id).toBe('image-a')
    expect(readRemoteDraft('host-b', 'same')).toEqual({ text: 'B', attachments: [] })
  })
  it('persists before sending, blocks another action, and checks the originating host before an explicit retry', async () => {
    invoke.mockImplementationOnce(async (method, params) => {
      expect(method).toBe('machines.command')
      expect(readReceipt('host-a', 'same')?.command).toEqual(params.command)
      throw new Error('Connection lost')
    })
    await expect(
      sendRemote('host-a', 'same', {
        op: 'session.prompt',
        sessionId: 'same',
        text: 'A',
        attachmentIds: ['image-a'],
      }),
    ).rejects.toThrow('Connection lost')
    const receipt = readReceipt('host-a', 'same')!
    await expect(
      sendRemote('host-a', 'same', { op: 'session.interrupt', sessionId: 'same' }),
    ).rejects.toThrow('Check the unconfirmed')
    expect(invoke).toHaveBeenCalledTimes(1)
    invoke
      .mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'no such key' } })
      .mockResolvedValueOnce({ ok: true, result: { accepted: true } })
    await resolveReceipt('host-a', 'same', true)
    expect(invoke.mock.calls[1]).toEqual([
      'machines.query',
      {
        machineId: 'host-a',
        query: { op: 'command.status', idempotencyKey: receipt.command.idempotencyKey },
      },
    ])
    expect(invoke.mock.calls[2]).toEqual([
      'machines.command',
      { machineId: 'host-a', command: receipt.command },
    ])
    expect(readReceipt('host-a', 'same')).toBeNull()
    expect(readReceipt('host-b', 'same')).toBeNull()
  })
  it('does not resend after a read-only receipt check fails or the host has already recorded success', async () => {
    invoke.mockRejectedValueOnce(new Error('lost'))
    await expect(
      sendRemote('host-a', 'same', { op: 'session.queue', sessionId: 'same', text: 'queued' }),
    ).rejects.toThrow()
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'missing' } })
    await expect(resolveReceipt('host-a', 'same')).rejects.toThrow('explicitly retry')
    expect(readReceipt('host-a', 'same')).not.toBeNull()
    invoke.mockResolvedValueOnce({ ok: true, result: { accepted: true } })
    await resolveReceipt('host-a', 'same', true)
    expect(invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
  })
  it('fails before IPC when storage or relative-path validation fails', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    await expect(
      sendRemote('host-a', 'same', { op: 'session.interrupt', sessionId: 'same' }),
    ).rejects.toThrow('receipt could not be saved')
    storage.mockRestore()
    await expect(
      remoteQuery('host-a', { op: 'files.read', sessionId: 'same', path: 'C:/local/file' }),
    ).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('retains structured unreachable failures and unwraps nested recorded outcomes', async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unreachable', message: 'Host offline' },
    })
    await expect(
      sendRemote('host-a', 'same', { op: 'session.prompt', sessionId: 'same', text: 'hello' }),
    ).rejects.toThrow('Host offline')
    expect(readReceipt('host-a', 'same')).not.toBeNull()
    invoke.mockResolvedValueOnce({ ok: true, result: { ok: true, result: { accepted: true } } })
    expect(await resolveReceipt('host-a', 'same')).toEqual({ accepted: true })
    expect(readReceipt('host-a', 'same')).toBeNull()
  })
  it('rejects a saved command bound to another session and retains malformed creation outcomes', async () => {
    await expect(
      sendRemote('host-a', 'same', { op: 'session.prompt', sessionId: 'different', text: 'hello' }),
    ).rejects.toThrow('another session')
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockResolvedValueOnce({ ok: true, result: { wrong: 'shape' } })
    await expect(
      sendRemote('host-a', 'new-session', { op: 'session.create', projectId: 'host-project' }),
    ).rejects.toThrow()
    expect(readReceipt('host-a', 'new-session')).not.toBeNull()
  })
  it('retains a receipt when an accepted command is followed by a named internal error', async () => {
    let executions = 0
    invoke.mockImplementationOnce(async () => {
      executions++
      return {
        ok: false,
        error: { code: 'internal_error', message: 'Completion receipt persistence failed' },
      }
    })
    await expect(
      sendRemote('host-a', 'same', {
        op: 'session.prompt',
        sessionId: 'same',
        text: 'accepted once',
      }),
    ).rejects.toThrow('persistence failed')
    const saved = readReceipt('host-a', 'same')!
    await expect(
      sendRemote('host-a', 'same', {
        op: 'session.prompt',
        sessionId: 'same',
        text: 'accepted once',
      }),
    ).rejects.toThrow('Check the unconfirmed')
    invoke.mockResolvedValueOnce({ ok: true, result: { ok: true, result: { accepted: true } } })
    await resolveReceipt('host-a', 'same', true)
    expect(executions).toBe(1)
    expect(invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
    expect(invoke.mock.calls[1]![1].query.idempotencyKey).toBe(saved.command.idempotencyKey)
    expect(readReceipt('host-a', 'same')).toBeNull()
  })
  it('retains in-flight conflicts through reconciliation and does not resend even on explicit retry', async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Still running' },
    })
    await expect(
      sendRemote('host-a', 'same', { op: 'session.interrupt', sessionId: 'same' }),
    ).rejects.toThrow('Still running')
    const saved = readReceipt('host-a', 'same')!
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'conflict', message: 'Still running' },
    })
    await expect(resolveReceipt('host-a', 'same', true)).rejects.toThrow('Still running')
    expect(readReceipt('host-a', 'same')).toEqual(saved)
    expect(invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
    invoke.mockResolvedValueOnce({ ok: true, result: { accepted: true } })
    await resolveReceipt('host-a', 'same')
    expect(readReceipt('host-a', 'same')).toBeNull()
  })
  it.each(['internal_error', 'conflict', 'not_found', 'unreachable', 'future_failure'])(
    'retains the exact receipt for uncertain %s failures', async (code) => {
      invoke.mockResolvedValueOnce({ ok: false, error: { code, message: 'Outcome unknown' } })
      await expect(sendRemote('host-a', 'same', {
        op: 'session.interrupt', sessionId: 'same',
      })).rejects.toThrow('Outcome unknown')
      const saved = readReceipt('host-a', 'same')!
      invoke.mockResolvedValueOnce({ ok: false, error: { code: 'conflict', message: 'Unknown' } })
      await expect(resolveReceipt('host-a', 'same', true)).rejects.toThrow('Unknown')
      expect(readReceipt('host-a', 'same')).toEqual(saved)
      expect(invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
    },
  )
  it('clears only a proven guard refusal or explicit non-acceptance', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'access_revoked', message: 'Revoked' } })
    await expect(sendRemote('host-a', 'same', {
      op: 'session.interrupt', sessionId: 'same',
    })).rejects.toThrow('Revoked')
    expect(readReceipt('host-a', 'same')).toBeNull()
    invoke.mockResolvedValueOnce({ ok: true, result: { accepted: false, reason: 'Not running' } })
    await expect(sendRemote('host-a', 'same', {
      op: 'session.interrupt', sessionId: 'same',
    })).rejects.toThrow('Not running')
    expect(readReceipt('host-a', 'same')).toBeNull()
  })
  it('retains a malformed fork result until the host confirms the actual wire shape', async () => {
    invoke.mockResolvedValueOnce({ ok: true, result: { child: { id: 'forked' } } })
    await expect(sendRemote('host-a', 'same', {
      op: 'session.fork', sessionId: 'same', title: 'Host fork',
    })).rejects.toThrow()
    expect(readReceipt('host-a', 'same')).not.toBeNull()
    invoke.mockResolvedValueOnce({ ok: true, result: { ok: true, result: { sessionId: 'forked' } } })
    expect(await resolveReceipt('host-a', 'same')).toEqual({ sessionId: 'forked' })
    expect(readReceipt('host-a', 'same')).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
  })
})
