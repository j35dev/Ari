// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { calmStream, currentMessages, currentRows, qoderFixtures } from './qoder-stream'

describe('Qoder screenshot mechanisms, using synthetic ACP frames', () => {
  const fragmented = qoderFixtures[0]!
  const long = qoderFixtures[1]!
  it('the corrected shared renderer coalesces alternating text/private updates', () => {
    const rows = currentRows(fragmented.frames)
    expect(rows.filter((row) => row.kind === 'markdown')).toHaveLength(1)
    expect(rows.filter((row) => row.kind === 'thinking')).toHaveLength(1)
  })
  it('keeps every public byte in one message and omits private content', () => {
    const result = calmStream(fragmented.frames)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.text).toBe(
      'The subscription check is complete. No changes were made.',
    )
    expect(result.privateUpdates).toBe(9)
    expect(JSON.stringify(result.messages)).not.toContain('synthetic activity')
  })
  it('a longer timer alone cannot coalesce alternating part kinds', () => {
    expect(currentMessages(fragmented.frames)[0]?.parts.map((part) => part.type)).toEqual(
      Array.from({ length: 18 }, (_, i) => (i % 2 ? 'thinking' : 'text')),
    )
  })
  it('coalesces a public round across private chunks even without fixture IDs', () => {
    const result = calmStream(
      fragmented.frames.map(({ utterance: _utterance, phase: _phase, ...frame }) => frame),
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.phase).toBe('unclassified')
    expect(result.messages[0]?.text).toBe(
      'The subscription check is complete. No changes were made.',
    )
  })
  it('the real grouper creates forty bursts for forty legitimate progress/tool cycles', () => {
    expect(currentRows(long.frames).filter((row) => row.kind === 'tool-group')).toHaveLength(40)
    expect(calmStream(long.frames).operations).toHaveLength(40)
  })
  it('keeps all updates and outputs in a single execution ledger', () => {
    const result = calmStream(long.frames)
    expect(result.messages.filter((message) => message.phase === 'progress')).toHaveLength(40)
    expect(result.messages.filter((message) => message.phase === 'reply')).toHaveLength(1)
    expect(result.operations.filter((operation) => operation.status === 'failed')).toHaveLength(1)
    expect(result.operations.every((operation) => operation.output.length > 0)).toBe(true)
  })
  it('reconnect does not duplicate messages, calls or output', () => {
    expect(calmStream(long.frames.concat(long.frames).reverse())).toEqual(calmStream(long.frames))
  })
})
