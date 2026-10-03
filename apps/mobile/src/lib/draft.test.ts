import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDraft, writeDraft, readPending, writePending } from './draft'
import { readTerminalState, writeTerminalState } from './terminal-state'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('mobile recovery state', () => {
  it('restores the exact uncertain submission without sharing receipts between phones or computers', () => {
    const pending = {
      key: 'receipt-12345678',
      mode: 'queue' as const,
      text: 'continue the task',
      attachmentIds: ['image-1'],
    }
    writePending('https://one.example', 'phone-1', 'session-1', pending)
    expect(readPending('https://one.example', 'phone-1', 'session-1')).toEqual(pending)
    expect(readPending('https://two.example', 'phone-1', 'session-1')).toBeNull()
    expect(readPending('https://one.example', 'phone-2', 'session-1')).toBeNull()
    writePending('https://one.example', 'phone-1', 'session-1', null)
    expect(readPending('https://one.example', 'phone-1', 'session-1')).toBeNull()
  })
  it('rejects a corrupt receipt and a command from another session', () => {
    const key = 'ari.pending:https://one.example:phone-1:session-1'
    sessionStorage.setItem(
      key,
      JSON.stringify({
        op: 'session.archive',
        sessionId: 'session-1',
        clientCommandId: 'one',
        idempotencyKey: 'receipt-1234',
      }),
    )
    expect(readPending('https://one.example', 'phone-1', 'session-1')).toBeNull()
    sessionStorage.setItem(
      key,
      JSON.stringify({
        op: 'session.prompt',
        sessionId: 'session-2',
        text: 'hello',
        clientCommandId: 'one',
        idempotencyKey: 'receipt-1234',
      }),
    )
    expect(readPending('https://one.example', 'phone-1', 'session-1')).toBeNull()
  })
  it('keeps offline drafts scoped to their computer and session', () => {
    writeDraft('https://one.example', 'session-1', 'offline draft')
    expect(readDraft('https://one.example', 'session-1')).toBe('offline draft')
    expect(readDraft('https://two.example', 'session-1')).toBe('')
    expect(readDraft('https://one.example', 'session-2')).toBe('')
  })
  it('does not restore a forgotten phone’s draft for a new paired device', () => {
    writeDraft('https://one.example', 'session-1', 'private draft', 'old-phone')
    expect(readDraft('https://one.example', 'session-1', 'old-phone')).toBe('private draft')
    expect(readDraft('https://one.example', 'session-1', 'new-phone')).toBe('')
  })
  it('restores shell identity and pending creation, and remembers an explicit close', () => {
    writeTerminalState('https://one.example', 'phone-1', 'session-1', {
      terminalId: null,
      creationKey: 'receipt-1234',
      closed: false,
    })
    expect(readTerminalState('https://one.example', 'phone-1', 'session-1').creationKey).toBe(
      'receipt-1234',
    )
    writeTerminalState('https://one.example', 'phone-1', 'session-1', {
      terminalId: 'terminal-1',
      creationKey: null,
      closed: false,
    })
    expect(readTerminalState('https://one.example', 'phone-1', 'session-1').terminalId).toBe(
      'terminal-1',
    )
    expect(readTerminalState('https://one.example', 'phone-2', 'session-1').terminalId).toBeNull()
    writeTerminalState('https://one.example', 'phone-1', 'session-1', {
      terminalId: null,
      creationKey: null,
      closed: true,
    })
    expect(readTerminalState('https://one.example', 'phone-1', 'session-1').closed).toBe(true)
  })
})
