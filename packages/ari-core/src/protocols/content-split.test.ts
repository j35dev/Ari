import { describe, expect, it } from 'vitest'
import { StreamContent } from './content-split'

function collect(s: StreamContent, chunks: string[]) {
  const events = chunks.flatMap((c) => s.push(c))
  const end = s.end()
  return { events: [...events, ...end.events], dsml: end.dsml }
}

describe('StreamContent', () => {
  it('passes ordinary text through', () => {
    const { events, dsml } = collect(new StreamContent(), ['Hel', 'lo'])
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
    ])
    expect(dsml).toBeNull()
  })

  it('routes <think>…</think> to thinking-delta and the rest to text', () => {
    const { events } = collect(new StreamContent(), [
      '<think>The user said hi.</think>\n\nHi! How can I help?',
    ])
    expect(events).toEqual([
      { type: 'thinking-delta', text: 'The user said hi.' },
      { type: 'text-delta', text: '\n\nHi! How can I help?' },
    ])
  })

  it('splits an open tag across chunks', () => {
    const { events } = collect(new StreamContent(), ['<th', 'ink>hmm</think>ok'])
    expect(events.map((e) => e.type)).toEqual(['thinking-delta', 'text-delta'])
    expect(events[0]).toEqual({ type: 'thinking-delta', text: 'hmm' })
    expect(events[1]).toEqual({ type: 'text-delta', text: 'ok' })
  })

  it('treats an unclosed think block as thinking', () => {
    const { events } = collect(new StreamContent(), ['<think>still going'])
    expect(events).toEqual([{ type: 'thinking-delta', text: 'still going' }])
  })

  it('does not leak the tags into text', () => {
    const { events } = collect(new StreamContent(), ['<thinking>plan</thinking>answer'])
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('answer')
    expect(text).not.toContain('thinking')
    expect(events.some((e) => e.type === 'thinking-delta' && e.text === 'plan')).toBe(true)
  })
})
