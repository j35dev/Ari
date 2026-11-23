import { describe, expect, it } from 'vitest'
import { AcpUpdateFolder } from './protocol'

describe('ACP stream preservation used by Pi and compatible Qoder sessions', () => {
  it('keeps channel IDs stable through interleaved deltas and advances only at tool boundaries', () => {
    const folder = new AcpUpdateFolder(() => 0, { preserveStreams: true })
    folder.beginTurn()
    const text = (value: string) =>
      folder.fold({
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
      })[0]
    const first = text('sub')
    const thought = folder.fold({
      sessionId: 's',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'opaque' } },
    })[0]
    const second = text('scription')
    expect(first).toMatchObject({ streamId: 'acp:s:1:0:text-delta' })
    expect(second).toMatchObject({ streamId: 'acp:s:1:0:text-delta' })
    expect(thought).toMatchObject({ streamId: 'acp:s:1:0:thinking-delta' })
    folder.fold({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        kind: 'execute',
        status: 'in_progress',
      },
    })
    expect(text('Next message.')).toMatchObject({ streamId: 'acp:s:1:1:text-delta' })
  })
  it('retains output-only progress without marking the call complete', () => {
    const folder = new AcpUpdateFolder()
    folder.fold({
      update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Run', status: 'pending' },
    })
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'in_progress',
      rawOutput: 'partial',
    }
    expect(folder.fold({ update })).toEqual([
      { type: 'tool-progress', callId: 't', resultJson: '"partial"' },
    ])
    expect(folder.fold({ update })).toEqual([])
    expect(
      folder.fold({
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
      }),
    ).toContainEqual({
      type: 'tool-completed',
      callId: 't',
      resultJson: '"partial"',
      isError: false,
    })
  })
})
