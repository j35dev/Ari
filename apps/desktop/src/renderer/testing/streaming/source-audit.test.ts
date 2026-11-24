// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AcpUpdateFolder } from '../../../../../../packages/providers/src/acp/protocol'
import { mapOpencodeLine } from '../../../../../../packages/providers/src/opencode/mapper'
import { mapPiLine } from '../../../../../../packages/providers/src/pi/mapper'
import { createAppServerMapper } from '../../../../../../packages/providers/src/codex/mapper'
import { streamProcessEvents } from '../../../../../../packages/providers/src/process-stream'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'
import { groupBlocks } from '../../src/features/transcript/groupBlocks'
import type { TranscriptBlock } from '../../src/features/transcript/types'

describe('source-confirmed edge cases (documents behavior, does not fix production)', () => {
  it('Codex app-server drops command output deltas from normalized events', () => {
    const mapper = createAppServerMapper()
    const result = mapper.mapLine(
      JSON.stringify({
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 't', turnId: 'r', itemId: 'a', delta: 'partial output' },
      }),
    )
    expect(result.kind === 'notification' && result.events).toEqual([])
  })
  it('Codex app-server suppresses a complete text fallback after any partial delta', () => {
    const mapper = createAppServerMapper()
    const partial = mapper.mapLine(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'r', itemId: 'a', delta: 'hel' },
      }),
    )
    const final = mapper.mapLine(
      JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 't',
          turnId: 'r',
          item: { id: 'a', type: 'agentMessage', text: 'hello' },
        },
      }),
    )
    expect(partial.kind === 'notification' && partial.events).toEqual([
      { type: 'text-delta', text: 'hel' },
    ])
    expect(final.kind === 'notification' && final.events).toEqual([])
  })
  it('the shared CLI pump preserves a final JSON line without a newline', async () => {
    class FixtureProcess extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
    }
    const child = new FixtureProcess()
    const mapped: string[] = []
    const iterator = streamProcessEvents(
      child,
      (line) => {
        mapped.push(line)
        return []
      },
      { label: 'fixture', handshakeTimeoutMs: 0 },
    )[Symbol.asyncIterator]()
    const first = iterator.next()
    child.stdout.write('{"type":"final"}')
    child.emit('close', 0)
    expect((await first).value).toEqual({ type: 'done' })
    expect(mapped).toEqual(['{"type":"final"}'])
  })
  it('OpenCode legacy mapper completes a running tool prematurely', () => {
    const result = mapOpencodeLine(
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'a',
          state: { status: 'running', input: {}, output: 'partial' },
        },
      }),
    )
    expect(result.map((event) => event.type)).toEqual(['tool-started', 'tool-completed'])
  })
  it('Pi legacy mapper ignores text deltas and tool progress', () => {
    expect(
      mapPiLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
        }),
      ),
    ).toEqual([])
    expect(
      mapPiLine(
        JSON.stringify({
          type: 'tool_execution_update',
          toolCallId: 'a',
          partialResult: 'partial',
        }),
      ),
    ).toEqual([])
  })
  it('ACP deduplicates repeated terminal updates', () => {
    const folder = new AcpUpdateFolder(() => 0)
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
      rawOutput: 'done',
    }
    expect(folder.fold({ update }).map((event) => event.type)).toEqual([
      'tool-started',
      'tool-completed',
    ])
    expect(folder.fold({ update }).map((event) => event.type)).toEqual([])
  })
  it('ACP retains nonterminal output when completion omits it', () => {
    const folder = new AcpUpdateFolder(() => 0)
    folder.fold({
      update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'Read', status: 'pending' },
    })
    folder.fold({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'a',
        status: 'in_progress',
        rawOutput: 'partial output',
      },
    })
    const result = folder.fold({
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' },
    })
    expect(result.find((event) => event.type === 'tool-completed')).toMatchObject({
      resultJson: '"partial output"',
    })
  })
  it('the shared part fold replaces starts and repeated results', () => {
    const parts: MessagePart[] = []
    const call: MessagePart = { type: 'tool-call', callId: 'a', name: 'read', argsJson: '{}' }
    const result: MessagePart = {
      type: 'tool-result',
      callId: 'a',
      resultJson: 'done',
      isError: false,
    }
    pushMessageParts(parts, [call, call, result, result])
    expect(parts.map((part) => part.type)).toEqual(['tool-call', 'tool-result'])
  })
  it('the current grouper separates tool-only turn boundaries', () => {
    const blocks: TranscriptBlock[] = ['a', 'b'].map((turnId, index) => ({
      kind: 'tool-call',
      key: `${index}`,
      role: 'assistant',
      turnId,
      callId: `${index}`,
      name: 'read',
      argsJson: '{}',
    }))
    const rows = groupBlocks(blocks)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.kind === 'tool-group' && rows[0].calls).toHaveLength(1)
  })
  it('an empty assistant text block creates otherwise invisible group boundaries', () => {
    const blocks: TranscriptBlock[] = [
      { kind: 'tool-call', key: 'a', role: 'assistant', callId: 'a', name: 'bash' },
      { kind: 'markdown', key: 'empty', role: 'assistant', text: '' },
      { kind: 'tool-call', key: 'b', role: 'assistant', callId: 'b', name: 'bash' },
    ]
    expect(groupBlocks(blocks).map((row) => row.kind)).toEqual([
      'tool-group',
      'markdown',
      'tool-group',
    ])
  })
})
