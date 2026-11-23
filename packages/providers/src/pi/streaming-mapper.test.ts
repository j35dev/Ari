import { describe, expect, it } from 'vitest'
import { PiMessageMapper } from './mapper'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'

describe('Pi print-mode streaming', () => {
  it('reconciles interleaved deltas and a completed message without duplicate text', () => {
    const mapper = new PiMessageMapper()
    const feed = (value: unknown) => mapper.mapLine(JSON.stringify(value))
    feed({ type: 'session', id: 'pi-session' })
    feed({ type: 'message_start', message: { role: 'assistant' } })
    const events = [
      ...feed({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'sub' },
      }),
      ...feed({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'opaque fixture' },
      }),
      ...feed({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'scription' },
      }),
      ...feed({
        type: 'message_end',
        message: {
          role: 'assistant',
          timestamp: 1,
          content: [
            { type: 'text', text: 'subscription.' },
            { type: 'thinking', thinking: 'opaque fixture' },
          ],
        },
      }),
    ]
    const parts: MessagePart[] = []
    for (const event of events)
      if (event.type === 'text-delta' || event.type === 'thinking-delta')
        pushMessageParts(parts, [
          {
            type: event.type === 'text-delta' ? 'text' : 'thinking',
            text: event.text,
            streamId: event.streamId,
            replace: event.replace,
          },
        ])
    expect(parts.filter((part) => part.type === 'text')).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'subscription.',
      streamId: 'pi:pi-session:1:text-delta:0',
    })
    expect(parts.filter((part) => part.type === 'thinking')).toHaveLength(1)
  })
  it('does not mistake partial output for completion', () => {
    const mapper = new PiMessageMapper()
    expect(
      mapper.mapLine(
        JSON.stringify({
          type: 'tool_execution_update',
          toolCallId: 'call',
          partialResult: { content: [{ type: 'text', text: 'running' }] },
        }),
      ),
    ).toEqual([
      {
        type: 'tool-progress',
        callId: 'call',
        resultJson: '{"content":[{"type":"text","text":"running"}]}',
      },
    ])
  })
  it('keeps identical replies from different messages and ignores only repeated authoritative delivery', () => {
    const mapper = new PiMessageMapper()
    const finish = (timestamp: number) =>
      mapper.mapLine(
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', timestamp, content: [{ type: 'text', text: 'OK' }] },
        }),
      )
    expect(finish(1)).toHaveLength(1)
    expect(finish(1)).toEqual([])
    expect(finish(2)).toHaveLength(1)
  })
})
