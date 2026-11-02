import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { AcpUpdateFolder } from './protocol'
import type { AcpSessionUpdate } from './protocol'

const claude = (toolName: string, extra: Record<string, unknown> = {}) => ({
  claudeCode: { toolName, ...extra },
})

const background = (events: AgentEvent[]) =>
  events.filter((event) => event.type === 'background-task')

function feed(folder: AcpUpdateFolder, updates: AcpSessionUpdate[]): AgentEvent[] {
  return updates.flatMap((update) => folder.fold({ sessionId: 'agent_1', update }))
}

describe('background work from Claude tool calls', () => {
  it('follows a sub-agent from its call to its result, with its latest child tool', () => {
    const folder = new AcpUpdateFolder()
    const events = feed(folder, [
      // The input still streams when the call is first reported.
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent_1',
        status: 'pending',
        title: 'Task',
        rawInput: {},
        _meta: claude('Agent'),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_1',
        rawInput: { description: 'Survey the repo', subagent_type: 'Explore', prompt: 'Look' },
        _meta: claude('Agent'),
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'child_1',
        status: 'pending',
        title: 'Read src/a.ts',
        _meta: claude('Read', { parentToolUseId: 'agent_1' }),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_1',
        status: 'in_progress',
        _meta: claude('Agent', {
          toolResponse: { elapsedTimeSeconds: 4, subagentType: 'Explore' },
        }),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_1',
        status: 'completed',
        rawOutput: 'Found it.',
        _meta: claude('Agent'),
      },
      // The PostToolUse hook can trail the result; it changes nothing here.
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_1',
        _meta: claude('Agent', { toolResponse: { status: 'completed' } }),
      },
    ])

    expect(background(events)).toEqual([
      {
        type: 'background-task',
        id: 'agent_1',
        kind: 'subagent',
        label: 'Sub-agent',
        status: 'running',
        detail: null,
      },
      expect.objectContaining({ label: 'Survey the repo', status: 'running', detail: 'Explore' }),
      expect.objectContaining({ status: 'running', detail: 'Read src/a.ts' }),
      expect.objectContaining({ status: 'completed', detail: 'Read src/a.ts' }),
    ])
    // The transcript still gets the same tool parts as before.
    expect(events.filter((event) => event.type === 'tool-started')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'tool-completed')).toHaveLength(1)
  })

  it('keeps an async sub-agent running past its call until the prompt returns', () => {
    const folder = new AcpUpdateFolder()
    const events = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent_2',
        status: 'pending',
        rawInput: { description: 'Write the docs', run_in_background: true },
        _meta: claude('Task'),
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'agent_2', status: 'completed' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_2',
        _meta: claude('Task', { toolResponse: { status: 'async_launched', agentId: 'a7' } }),
      },
    ])
    expect(background(events)).toEqual([
      expect.objectContaining({ id: 'agent_2', label: 'Write the docs', status: 'running' }),
    ])
    expect(folder.endPrompt('end_turn')).toEqual([
      expect.objectContaining({ id: 'agent_2', status: 'completed' }),
    ])
    // Reports after the prompt ended are stale.
    expect(
      background(
        feed(folder, [
          {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'agent_2',
            _meta: claude('Task', { toolResponse: { status: 'async_launched' } }),
          },
        ]),
      ),
    ).toEqual([])
  })

  it('reopens a sub-agent whose async marker arrives after its call completed', () => {
    const folder = new AcpUpdateFolder()
    const events = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent_3',
        rawInput: { description: 'Audit' },
        _meta: claude('Agent'),
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'agent_3', status: 'completed' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'agent_3',
        _meta: claude('Agent', { toolResponse: { status: 'async_launched', isAsync: true } }),
      },
    ])
    expect(background(events).map((event) => (event as { status: string }).status)).toEqual([
      'running',
      'completed',
      'running',
    ])
    expect(folder.endPrompt('cancelled')).toEqual([
      expect.objectContaining({ id: 'agent_3', status: 'stopped' }),
    ])
  })

  it('opens a shell only when it runs in the background, and keeps it past its call', () => {
    const folder = new AcpUpdateFolder()
    const events = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'fg',
        rawInput: { command: 'ls' },
        _meta: claude('Bash'),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'fg',
        status: 'completed',
        _meta: claude('Bash'),
      },
      { sessionUpdate: 'tool_call', toolCallId: 'bg', rawInput: {}, _meta: claude('Bash') },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg',
        rawInput: { command: 'npm test', description: 'Run tests', run_in_background: true },
        _meta: claude('Bash'),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg',
        status: 'completed',
        _meta: claude('Bash'),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'bg',
        _meta: claude('Bash', { toolResponse: { backgroundTaskId: 'b1' } }),
      },
    ])
    expect(background(events)).toEqual([
      {
        type: 'background-task',
        id: 'bg',
        kind: 'shell',
        label: 'Run tests',
        status: 'running',
        detail: null,
      },
    ])
    // The prompt ending does not end a shell.
    expect(folder.endPrompt('end_turn')).toEqual([])

    // The agent stopping it by its task id does.
    const stopped = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'stop_1',
        rawInput: { task_id: 'b1' },
        _meta: claude('TaskStop'),
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'stop_1',
        status: 'completed',
        _meta: claude('TaskStop'),
      },
    ])
    expect(background(stopped)).toEqual([
      expect.objectContaining({ id: 'bg', status: 'stopped', detail: 'Stopped by the agent' }),
    ])
  })

  it('marks a background shell that never started as failed', () => {
    const folder = new AcpUpdateFolder()
    const events = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'bg',
        rawInput: { command: 'npm run dev', run_in_background: true },
        _meta: claude('PowerShell'),
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'failed' },
    ])
    expect(background(events).at(-1)).toMatchObject({ status: 'failed', label: 'npm run dev' })
  })
})

describe('background work between turns', () => {
  function withShells(count: number, clock: { now: number }): AcpUpdateFolder {
    const folder = new AcpUpdateFolder(() => clock.now)
    for (let i = 0; i < count; i++)
      feed(folder, [
        {
          sessionUpdate: 'tool_call',
          toolCallId: `bg_${i}`,
          rawInput: { command: `job ${i}`, run_in_background: true },
          _meta: claude('Bash'),
        },
      ])
    folder.endPrompt('end_turn')
    return folder
  }
  const say = (text: string) => ({
    sessionId: 'agent_1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  })

  it('takes a report as the end of the only shell that was running', () => {
    const clock = { now: 0 }
    const folder = withShells(1, clock)
    clock.now = 60_000
    expect(folder.foldBetweenTurns(say('Tests passed.'))).toEqual([
      { type: 'text-delta', text: 'Tests passed.' },
      expect.objectContaining({
        id: 'bg_0',
        status: 'completed',
        detail: 'The agent reported back',
      }),
    ])
  })

  it('cannot attribute a report while several shells run', () => {
    const clock = { now: 0 }
    const folder = withShells(2, clock)
    clock.now = 60_000
    expect(background(folder.foldBetweenTurns(say('One of them finished.')))).toEqual([])
  })

  it('never ends a shell the same report started', () => {
    const clock = { now: 0 }
    const folder = withShells(0, clock)
    clock.now = 60_000
    const events = [
      ...folder.foldBetweenTurns({
        sessionId: 'agent_1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'bg_new',
          rawInput: { command: 'npm run dev', run_in_background: true },
          _meta: claude('Bash'),
        },
      }),
      ...folder.foldBetweenTurns(say('Server started.')),
    ]
    expect(background(events)).toEqual([
      expect.objectContaining({ id: 'bg_new', status: 'running' }),
    ])
  })

  it('still attributes the report when it launches another shell first', () => {
    const clock = { now: 0 }
    const folder = withShells(1, clock)
    clock.now = 60_000
    const events = [
      ...folder.foldBetweenTurns({
        sessionId: 'agent_1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'bg_next',
          rawInput: { command: 'npm run build', run_in_background: true },
          _meta: claude('Bash'),
        },
      }),
      ...folder.foldBetweenTurns(say('Tests passed; building now.')),
    ]
    expect(background(events)).toEqual([
      expect.objectContaining({ id: 'bg_next', status: 'running' }),
      expect.objectContaining({ id: 'bg_0', status: 'completed' }),
    ])
  })

  it('forgets what earlier turns left open when a new turn begins', () => {
    const clock = { now: 0 }
    const folder = withShells(1, clock)
    folder.beginTurn()
    clock.now = 60_000
    expect(background(folder.foldBetweenTurns(say('Done.')))).toEqual([])
  })
})

describe('background work from Codex collab agents', () => {
  it('opens a sub-agent per spawned thread and ends it from its reported state', () => {
    const folder = new AcpUpdateFolder()
    const collab = (tool: string) => ({
      codex: { collaboration: { tool, senderThreadId: 'root', receiverThreadIds: ['t1'] } },
    })
    const events = feed(folder, [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'spawn_1',
        kind: 'other',
        title: 'spawnAgent',
        status: 'in_progress',
        rawInput: {
          prompt: 'Check the failing tests\nand report back',
          receiverThreadIds: ['t1'],
          agentsStates: { t1: { status: 'pendingInit' } },
        },
        _meta: collab('spawnAgent'),
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'wait_1',
        title: 'wait',
        status: 'completed',
        rawInput: { receiverThreadIds: ['t1'], agentsStates: { t1: { status: 'completed' } } },
        _meta: collab('wait'),
      },
    ])
    expect(background(events)).toEqual([
      expect.objectContaining({
        id: 't1',
        kind: 'subagent',
        label: 'Check the failing tests',
        status: 'running',
      }),
      expect.objectContaining({ id: 't1', status: 'completed' }),
    ])
  })
})
