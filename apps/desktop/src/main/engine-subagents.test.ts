// @vitest-environment node
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  Options,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { journalEventSchema, type JournalEvent } from '@ari/contracts/events'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'
import { ClaudeDriver, ClaudeSessionPool, type ClaudeQuery } from '@ari/providers/claude'
import { DriverRegistry } from '@ari/providers/registry'
import { SessionStore } from '@ari/engine/session-store'
import { Engine } from './engine'

/** A recorded haiku session: a background subagent outlives the parent's turn. */
const FIXTURE = readFileSync(
  new URL(
    '../../../../packages/providers/src/claude/__fixtures__/sdk-background-subagent.jsonl',
    import.meta.url,
  ),
  'utf8',
)
const PROMPT_UUID = '00a2631b-5385-4c36-88a9-e7574e7117ca'
const NATIVE_SESSION = 'cbf623a3-2aef-4e54-ae3e-16d0104b6399'
const AGENT_CALL = 'toolu_018jShoFmjfipUtvKi8Lyqdb'
const CHILD_CALLS = ['toolu_01U4MgktyVfzfa2oADyNtNTR', 'toolu_013ag9LWoepBdSky97ywWgHb']
const SESSION_ID = 'sess_subagents'

function recording(promptUuid: string): Record<string, unknown>[] {
  return FIXTURE.replaceAll(PROMPT_UUID, promptUuid)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

class FakeQuery implements ClaudeQuery {
  readonly stream: SDKMessage[] = []
  readonly sent: SDKUserMessage[] = []
  #wake: (() => void) | null = null
  #ended = false
  readonly interrupt = vi.fn<() => Promise<SDKControlInterruptResponse | undefined>>(
    async () => undefined,
  )
  readonly stopTask = vi.fn(async (_taskId: string) => undefined)
  readonly close = vi.fn(() => {
    this.#ended = true
    this.#wake?.()
  })
  constructor(input: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const message of input) this.sent.push(message)
    })()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      const next = this.stream.shift()
      if (next) {
        yield next
        continue
      }
      if (this.#ended) return
      await new Promise<void>((resolve) => (this.#wake = resolve))
    }
  }
  emit(...messages: unknown[]): void {
    this.stream.push(...(messages as SDKMessage[]))
    this.#wake?.()
  }
}

const scratch: string[] = []
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-subagents-'))
  scratch.push(dir)
  const store = new SessionStore({ storage: 'jsonl', rootDir: dir })
  await store.append(SESSION_ID, {
    type: 'session.created',
    session: {
      id: SESSION_ID,
      projectId: 'adhoc',
      title: 'Subagents',
      driverKind: 'claude',
      modelId: 'haiku',
      permissionMode: 'full',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
  const pool = new ClaudeSessionPool()
  const queries: FakeQuery[] = []
  const registry = new DriverRegistry()
  registry.register(
    new ClaudeDriver('claude', {
      pool,
      query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
        const runtime = new FakeQuery(prompt)
        queries.push(runtime)
        return runtime
      },
    }),
  )
  const published: JournalEvent[] = []
  const engine = new Engine({
    store,
    registry,
    publish: (_sessionId, event) => published.push(event),
    git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
    backgroundAdapter: (sessionId) => pool.controls(sessionId),
  })
  pool.onBackground = (sessionId, events) => engine.recordBackground(sessionId, events)
  const close = async () => {
    await engine.shutdown(() => pool.shutdownAll())
    await store.closeJournal(SESSION_ID)
  }
  return { dir, store, pool, queries, engine, published, close }
}

/** Starts the parent's turn and plays the recording up to the parent's own result. */
async function firstTurn(h: Awaited<ReturnType<typeof setup>>) {
  await h.engine.dispatch({
    type: 'turn.start',
    sessionId: SESSION_ID,
    text: 'Use the Agent tool to list the files',
    attachments: [],
  })
  await vi.waitFor(() => expect(h.queries[0]?.sent).toHaveLength(1))
  const lines = recording(h.queries[0]!.sent[0]!.uuid!)
  const firstResult = lines.findIndex((line) => line['type'] === 'result')
  h.queries[0]!.emit(...lines.slice(0, firstResult + 1))
  await vi.waitFor(async () =>
    expect((await h.store.load(SESSION_ID)).lastTurn?.stopReason).toBe('completed'),
  )
  return lines.slice(firstResult + 1)
}

function toolCallIds(parts: readonly MessagePart[]): string[] {
  return parts.flatMap((part) => (part.type === 'tool-call' ? [part.callId] : []))
}

it('settles the parent while its background subagent runs, so a message sends instead of queueing', async () => {
  const h = await setup()
  try {
    const rest = await firstTurn(h)
    const settled = await h.store.load(SESSION_ID)
    expect(settled.activeTurnId).toBeNull()
    expect(settled.status).toBe('idle')
    expect(settled.backgroundTasks?.find((task) => task.id === AGENT_CALL)?.status).toBe('running')

    // The composer sends a turn now; the engine starts it on the same query.
    const receipt = await h.engine.dispatch({
      type: 'turn.start',
      sessionId: SESSION_ID,
      text: 'Meanwhile, say hi',
      attachments: [],
    })
    expect(receipt.accepted).toBe(true)
    await vi.waitFor(() => expect(h.queries[0]!.sent).toHaveLength(2))
    expect(h.queries).toHaveLength(1)
    const running = await h.store.load(SESSION_ID)
    expect(running.activeTurnId).not.toBeNull()
    expect(running.queuedMessages).toEqual([])

    // The subagent keeps reporting during that turn, into its own transcript.
    h.queries[0]!.emit(...rest.filter((line) => line['parent_tool_use_id'] === AGENT_CALL), {
      type: 'result',
      subtype: 'success',
      session_id: NATIVE_SESSION,
      user_message_uuids: [h.queries[0]!.sent[1]!.uuid],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await vi.waitFor(async () => expect((await h.store.load(SESSION_ID)).activeTurnId).toBeNull())
    const model = await h.store.load(SESSION_ID)
    expect(model.messages.flatMap((message) => toolCallIds(message.parts))).toEqual([AGENT_CALL])
    expect(
      h.published.filter(
        (event) => event.type === 'background.task.parts.appended' && event.taskId === AGENT_CALL,
      ).length,
    ).toBeGreaterThan(0)
  } finally {
    await h.close()
  }
})

it('journals a subagent’s work under its parent by task, durably and apart from the parent’s messages', async () => {
  const h = await setup()
  let closed = false
  try {
    const rest = await firstTurn(h)
    // Everything after the parent's result arrives between turns: the
    // subagent's work, then Claude waking to report on it.
    h.queries[0]!.emit(...rest)
    await vi.waitFor(async () => {
      const model = await h.store.load(SESSION_ID)
      expect(model.backgroundTasks?.find((task) => task.id === AGENT_CALL)?.status).toBe(
        'completed',
      )
      expect(
        model.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === 'text' && part.text.includes('The background agent has finished'),
          ),
        ),
      ).toBe(true)
    })
    await h.close()
    closed = true

    // A fresh store, as after an app restart, replays the same journal.
    const reopened = new SessionStore({ storage: 'jsonl', rootDir: h.dir })
    const model = await reopened.load(SESSION_ID)
    expect(reopened.replayDiagnostics(SESSION_ID).rejectedCount).toBe(0)
    const parentParts = model.messages.flatMap((message) => message.parts)
    expect(toolCallIds(parentParts)).toEqual([AGENT_CALL])
    expect(
      parentParts.some((part) => part.type === 'text' && part.text.includes('**File count:**')),
    ).toBe(false)
    expect(model.backgroundTasks?.find((task) => task.id === AGENT_CALL)).toMatchObject({
      kind: 'subagent',
      status: 'completed',
      label: 'List files in working folder',
      subagentType: 'general-purpose',
      model: 'claude-haiku-5-5',
    })
    const task = model.backgroundTasks!.find((entry) => entry.id === AGENT_CALL)!
    expect(task.prompt).toMatch(/^List the files in the folder/)
    expect(task.result).toMatch(/is nearly empty/)

    const journal = await reopened.openJournal(SESSION_ID)
    const subagentParts: MessagePart[] = []
    for (const entry of await journal.readAll()) {
      if (entry.kind !== 'value') continue
      const event = journalEventSchema.parse(entry.value)
      if (event.type === 'background.task.parts.appended' && event.taskId === AGENT_CALL)
        pushMessageParts(subagentParts, event.parts)
    }
    await reopened.closeJournal(SESSION_ID)
    expect(toolCallIds(subagentParts)).toEqual(CHILD_CALLS)
    expect(
      subagentParts.flatMap((part) => (part.type === 'tool-result' ? [part.callId] : [])),
    ).toEqual(CHILD_CALLS)
    expect(
      subagentParts.some((part) => part.type === 'text' && part.text.includes('**File count:**')),
    ).toBe(true)
  } finally {
    if (!closed) await h.close()
  }
})
