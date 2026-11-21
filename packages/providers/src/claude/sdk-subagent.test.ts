import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type {
  Options,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { AsyncQueue } from './async-queue'
import { ClaudeBackgroundTasks } from './background-tasks'
import { ClaudeDriver, type ClaudeQuery } from './claude-driver'
import { ClaudeMessageMapper, type NativeLine } from './mapper'
import { ClaudeSessionPool } from './session-pool'

/**
 * A real haiku session (recorded by claude-subagent.smoke.test.ts): the parent
 * starts a background `general-purpose` subagent with the Agent tool and ends
 * its turn; the subagent runs two Bash calls and answers; Claude then wakes
 * on its own to summarise the result.
 */
const FIXTURE = readFileSync(
  new URL('./__fixtures__/sdk-background-subagent.jsonl', import.meta.url),
  'utf8',
)
const PROMPT_UUID = '00a2631b-5385-4c36-88a9-e7574e7117ca'
const NATIVE_SESSION = 'cbf623a3-2aef-4e54-ae3e-16d0104b6399'
const AGENT_CALL = 'toolu_018jShoFmjfipUtvKi8Lyqdb'
const AGENT_TASK = 'a0636123e418ee747'
const CHILD_CALLS = ['toolu_01U4MgktyVfzfa2oADyNtNTR', 'toolu_013ag9LWoepBdSky97ywWgHb']

/** The recording, with its prompt's uuid swapped for the one this run sent. */
function recording(promptUuid = PROMPT_UUID): NativeLine[] {
  return FIXTURE.replaceAll(PROMPT_UUID, promptUuid)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as NativeLine)
}
const FIRST_RESULT = recording().findIndex((line) => line.type === 'result')

const SESSION: AdapterSession = {
  sessionId: 'ari',
  workspacePath: '/repo',
  prompt: 'Use the Agent tool to list the files',
  modelId: 'haiku',
  permissionMode: 'full',
  resumeOf: null,
}

class FakeQuery implements ClaudeQuery {
  readonly stream = new AsyncQueue<SDKMessage>()
  readonly sent: SDKUserMessage[] = []
  readonly interrupt = vi.fn<() => Promise<SDKControlInterruptResponse | undefined>>(
    async () => undefined,
  )
  readonly stopTask = vi.fn(async (_taskId: string) => undefined)
  readonly close = vi.fn(() => this.stream.end())
  constructor(
    readonly options: Options,
    input: AsyncIterable<SDKUserMessage>,
  ) {
    void (async () => {
      for await (const message of input) this.sent.push(message)
    })()
  }
  [Symbol.asyncIterator]() {
    return this.stream[Symbol.asyncIterator]()
  }
  emit(...messages: unknown[]): void {
    for (const message of messages) this.stream.push(message as SDKMessage)
  }
}

const pools: ClaudeSessionPool[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdownAll()
})
function harness() {
  const pool = new ClaudeSessionPool()
  pools.push(pool)
  const queries: FakeQuery[] = []
  const driver = new ClaudeDriver('claude', {
    pool,
    query: ({ prompt, options }) => {
      const runtime = new FakeQuery(options, prompt)
      queries.push(runtime)
      return runtime
    },
  })
  const between: AgentEvent[] = []
  pool.onBackground = (_sessionId, events) => between.push(...events)
  return { pool, driver, queries, between }
}
async function collect(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return events
}
/** Starts the first turn and plays the recording up to its first result. */
async function firstTurn(h: ReturnType<typeof harness>) {
  const adapter = await h.driver.create(SESSION)
  await vi.waitFor(() => expect(h.queries[0]?.sent).toHaveLength(1))
  const lines = recording(h.queries[0]!.sent[0]!.uuid)
  const reading = collect(adapter)
  h.queries[0]!.emit(...lines.slice(0, FIRST_RESULT + 1))
  const events = await reading
  await adapter.dispose()
  return { adapter, events, rest: lines.slice(FIRST_RESULT + 1) }
}
const subagentOf = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'subagent-activity' ? [event] : []))
const tasksOf = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'background-task' ? [event] : []))

describe('Claude SDK subagents', () => {
  it('routes every message with a parent_tool_use_id to its subagent, never the parent', () => {
    const mapper = new ClaudeMessageMapper()
    const roster = new ClaudeBackgroundTasks()
    const events = recording().flatMap((line) => [
      ...roster.observe(line),
      ...mapper.map(line as unknown as SDKMessage),
    ])
    const parentCalls = events.flatMap((event) =>
      event.type === 'tool-started' ? [event.callId] : [],
    )
    expect(parentCalls).toEqual([AGENT_CALL])
    const parentText = events
      .flatMap((event) => (event.type === 'text-delta' ? [event.text] : []))
      .join('')
    expect(parentText).toContain("I've started a background subagent")
    expect(parentText).toContain('The background agent has finished')
    expect(parentText).not.toContain('**File count:**')

    const child = subagentOf(events)
    expect(new Set(child.map((event) => event.taskId))).toEqual(new Set([AGENT_CALL]))
    expect(
      child.flatMap((event) => (event.event.type === 'tool-started' ? [event.event.callId] : [])),
    ).toEqual(CHILD_CALLS)
    expect(
      child.flatMap((event) => (event.event.type === 'tool-completed' ? [event.event.callId] : [])),
    ).toEqual(CHILD_CALLS)
    expect(
      child.some(
        (event) =>
          event.event.type === 'text-delta' && event.event.text.includes('**File count:**'),
      ),
    ).toBe(true)
    // A redacted thought carries no text and adds nothing.
    expect(child.some((event) => event.event.type === 'thinking-delta')).toBe(false)

    const reports = tasksOf(events).filter((event) => event.id === AGENT_CALL)
    expect(reports.at(-1)).toMatchObject({ kind: 'subagent', status: 'completed' })
    const details = Object.assign({}, ...reports) as Record<string, unknown>
    expect(details).toMatchObject({
      label: 'List files in working folder',
      subagentType: 'general-purpose',
      model: 'claude-haiku-5-5',
    })
    expect(String(details['prompt'])).toMatch(/^List the files in the folder/)
    expect(String(details['result'])).toMatch(/^The folder .* is nearly empty/)
    // The prompt is reported once, not again with every progress line.
    expect(reports.filter((report) => report.prompt !== undefined)).toHaveLength(1)
  })

  it('settles the parent at its own result while a background subagent runs on', async () => {
    const h = harness()
    const { adapter, events, rest } = await firstTurn(h)
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(adapter.keepsBackgroundWork?.()).toBe(true)
    expect(
      tasksOf(events)
        .filter((task) => task.id === AGENT_CALL)
        .at(-1)?.status,
    ).toBe('running')
    expect(subagentOf(events)).toEqual([])

    h.queries[0]!.emit(...rest)
    await vi.waitFor(() => expect(h.between.some((event) => event.type === 'done')).toBe(true))
    // The subagent's work arrives between turns as its own, never as parent prose.
    expect(
      h.between.flatMap((event) => (event.type === 'tool-started' ? [event.callId] : [])),
    ).toEqual([])
    expect(subagentOf(h.between).length).toBeGreaterThanOrEqual(5)
    const wake = h.between
      .flatMap((event) => (event.type === 'text-delta' ? [event.text] : []))
      .join('')
    expect(wake).toContain('The background agent has finished')
    expect(wake).not.toContain('**File count:**')
    expect(
      tasksOf(h.between)
        .filter((task) => task.id === AGENT_CALL)
        .at(-1)?.status,
    ).toBe('completed')
  })

  it('starts a new turn on the same query while the subagent runs, and keeps routing it', async () => {
    const h = harness()
    const { rest } = await firstTurn(h)
    const next = await h.driver.create({
      ...SESSION,
      prompt: 'Meanwhile, say hi',
      resumeOf: NATIVE_SESSION,
    })
    expect(h.queries).toHaveLength(1)
    await vi.waitFor(() => expect(h.queries[0]!.sent).toHaveLength(2))
    const reading = collect(next)
    const childLines = rest.filter((line) => line.parent_tool_use_id === AGENT_CALL)
    h.queries[0]!.emit(...childLines, {
      type: 'result',
      subtype: 'success',
      user_message_uuids: [h.queries[0]!.sent[1]!.uuid],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const events = await reading
    expect(events.filter((event) => event.type === 'tool-started')).toEqual([])
    expect(subagentOf(events).every((event) => event.taskId === AGENT_CALL)).toBe(true)
    expect(subagentOf(events).length).toBeGreaterThan(0)
    await next.dispose()
  })

  it('attributes a subagent permission request to it and stops it without a turn', async () => {
    const h = harness()
    const { events } = await firstTurn(h)
    expect(tasksOf(events).some((task) => task.id === AGENT_CALL)).toBe(true)
    const permission = h.queries[0]!.options.canUseTool!(
      'Bash',
      { command: 'ls' },
      {
        requestId: 'request',
        toolUseID: CHILD_CALLS[0]!,
        agentID: AGENT_TASK,
        signal: new AbortController().signal,
      },
    )
    await vi.waitFor(() =>
      expect(h.between.some((event) => event.type === 'approval-requested')).toBe(true),
    )
    const approval = h.between.find((event) => event.type === 'approval-requested')
    expect(approval).toMatchObject({ toolName: 'Bash', taskId: AGENT_CALL })
    h.pool
      .controls('ari')
      ?.respondApproval?.(
        approval?.type === 'approval-requested' ? approval.approvalId : '',
        'allow',
      )
    expect(await permission).toMatchObject({ behavior: 'allow' })

    expect(h.pool.stopSubagents('ari')).toBe(1)
    expect(h.queries[0]!.stopTask).toHaveBeenCalledWith(AGENT_TASK)
    expect(tasksOf(h.between).at(-1)).toMatchObject({ id: AGENT_CALL, status: 'stopped' })
    expect(h.pool.stopSubagents('ari')).toBe(0)
  })
})
