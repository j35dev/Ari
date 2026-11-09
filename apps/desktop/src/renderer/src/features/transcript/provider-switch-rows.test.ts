import { describe, expect, it } from 'vitest'
import type { ProviderSwitch, TranscriptBlock } from './types'
import { insertProviderSwitchRows } from './provider-switch-rows'

const change: ProviderSwitch = {
  type: 'session.provider.switched',
  seq: 5,
  at: 10,
  sessionId: 'aria',
  driverKind: 'claude',
  modelId: 'opus',
  effort: null,
  afterTurnId: 'old-turn',
  afterMessageId: 'old-message',
}
const old: TranscriptBlock = {
  kind: 'markdown',
  key: 'old-message#0',
  turnId: 'old-turn',
  role: 'assistant',
  text: 'Earlier reply',
}
const next: TranscriptBlock = {
  kind: 'markdown',
  key: 'new-message#0',
  turnId: 'new-turn',
  role: 'user',
  text: 'Next prompt',
}

describe('provider switch rows', () => {
  it('places the divider after the old turn, including output streamed after the switch', () => {
    const tail = { ...old, key: 'old-message#2', text: 'Finished old turn' }
    const rows = insertProviderSwitchRows([old, tail, next], [change])
    expect(rows.map((row) => row.key)).toEqual([old.key, tail.key, 'provider-switch:5', next.key])
    expect(rows[0]).toBe(old)
    expect(rows[3]).toBe(next)
  })

  it('keeps successive switches in journal order at the same boundary', () => {
    expect(
      insertProviderSwitchRows(
        [old, next],
        [change, { ...change, seq: 6, driverKind: 'opencode' }],
      ).map((row) => row.key),
    ).toEqual([old.key, 'provider-switch:5', 'provider-switch:6', next.key])
  })

  it('uses a message anchor for history without turn ids and handles an empty conversation', () => {
    const legacy = { ...change, afterTurnId: null }
    expect(insertProviderSwitchRows([{ ...old, turnId: null }, next], [legacy])[1]?.kind).toBe(
      'provider-switch',
    )
    expect(insertProviderSwitchRows([], [{ ...legacy, afterMessageId: null }])).toHaveLength(1)
    const rows = [old, next]
    expect(insertProviderSwitchRows(rows, [])).toBe(rows)
  })

  it('falls back to the last visible message when an automatic turn has no visible output', () => {
    const hiddenTurn = { ...change, afterTurnId: 'hidden-wake' }
    expect(insertProviderSwitchRows([old, next], [hiddenTurn]).map((row) => row.key)).toEqual([
      old.key,
      'provider-switch:5',
      next.key,
    ])
  })
})
