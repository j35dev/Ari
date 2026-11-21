import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type {
  SDKMessage,
  SDKUserMessage,
  Options,
  SDKControlInterruptResponse,
} from '@anthropic-ai/claude-agent-sdk'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { AsyncQueue } from './async-queue'
import { ClaudeDriver, buildClaudeOptions, type ClaudeQuery } from './claude-driver'
import { ClaudeSessionPool } from './session-pool'

const SESSION: AdapterSession = {
  sessionId: 'ari',
  workspacePath: '/repo',
  prompt: 'Research',
  modelId: 'haiku',
  permissionMode: 'ask',
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
  emit(message: unknown): void {
    this.stream.push(message as SDKMessage)
  }
  finish(extra: Record<string, unknown> = {}): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
      ...extra,
    })
  }
}
const pools: ClaudeSessionPool[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const pool of pools.splice(0)) await pool.shutdownAll()
})
function harness() {
  const pool = new ClaudeSessionPool(100, 1)
  pools.push(pool)
  const queries: FakeQuery[] = []
  const createQuery = vi.fn(
    ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const runtime = new FakeQuery(options, prompt)
      queries.push(runtime)
      return runtime
    },
  )
  const driver = new ClaudeDriver('claude', { pool, query: createQuery })
  return { pool, driver, queries, createQuery }
}
async function collect(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return events
}
function background(query: FakeQuery): void {
  query.emit({ type: 'system', subtype: 'init', session_id: 'native' })
  query.emit({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent',
    tool_use_id: 'call',
    task_type: 'local_agent',
    is_backgrounded: true,
    description: 'Research',
  })
}

describe('Claude SDK driver', () => {
  it('cancels accepted steering when the SDK interrupt reports that its input remains queued', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    expect(await adapter.steer!('Do a follow-up')).toBe(true)
    await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(2))
    queries[0]!.interrupt.mockResolvedValue({ still_queued: [queries[0]!.sent[1]!.uuid!] })
    const reading = collect(adapter)
    adapter.interrupt()
    expect((await reading).at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(queries[0]!.close).toHaveBeenCalledOnce()
    await adapter.dispose()
  })
  it('surfaces a permission replayed during SDK initialization before the prompt is submitted', async () => {
    const pool = new ClaudeSessionPool()
    pools.push(pool)
    let runtime!: FakeQuery
    let permission!: ReturnType<NonNullable<Options['canUseTool']>>
    const driver = new ClaudeDriver('claude', {
      pool,
      query: (input) => {
        runtime = new FakeQuery(input.options, input.prompt)
        permission = input.options.canUseTool!(
          'Bash',
          { command: 'echo ready' },
          { requestId: 'replay', toolUseID: 'replay', signal: new AbortController().signal },
        )
        return runtime
      },
    })
    const adapter = await driver.create(SESSION)
    const events: AgentEvent[] = []
    const reading = (async () => {
      for await (const event of adapter.start()) events.push(event)
    })()
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'approval-requested')).toBe(true),
    )
    const approval = events.find((event) => event.type === 'approval-requested')!
    if (approval.type !== 'approval-requested') throw new Error('missing replayed approval')
    adapter.respondApproval!(approval.approvalId, 'allow')
    expect(await permission).toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'echo ready' },
    })
    runtime.finish()
    await reading
    await adapter.dispose()
  })
  it('sends staged image bytes on both the initial prompt and a live steer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-sdk-image-'))
    const path = join(dir, 'image.png')
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
    await writeFile(path, bytes)
    const attachments = [{ id: 'image', name: 'image.png', mimeType: 'image/png', path }]
    try {
      const { driver, queries } = harness()
      const adapter = await driver.create({ ...SESSION, attachments })
      expect(await adapter.steer!('Compare this image', attachments)).toBe(true)
      await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(2))
      for (const message of queries[0]!.sent) {
        expect(JSON.stringify(message.message.content)).toContain(
          JSON.stringify({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
          }),
        )
      }
      const events = collect(adapter)
      queries[0]!.finish()
      await events
      await adapter.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps the existing model fallback notice when the installed harness no longer offers a saved pick', async () => {
    const pool = new ClaudeSessionPool()
    pools.push(pool)
    let runtime!: FakeQuery
    const setModel = vi.fn(async () => undefined)
    const driver = new ClaudeDriver('claude', {
      pool,
      query: (input) => {
        runtime = new FakeQuery(input.options, input.prompt)
        return Object.assign(runtime, {
          initializationResult: async () =>
            ({
              models: [
                {
                  value: 'default',
                  resolvedModel: 'opus',
                  displayName: 'Default',
                  description: 'Default',
                },
              ],
            }) as Awaited<ReturnType<NonNullable<ClaudeQuery['initializationResult']>>>,
          setModel,
        })
      },
    })
    const adapter = await driver.create(SESSION)
    const reading = collect(adapter)
    runtime.finish()
    expect(await reading).toContainEqual({
      type: 'notice',
      message: '"haiku" is not offered by this agent, so this turn ran on opus.',
    })
    expect(setModel).toHaveBeenCalledOnce()
    await adapter.dispose()
  })
  it('uses the compatibility transport for pre-prompt startup failure, then stays on its live session', async () => {
    const adapter: ProviderAdapter = {
      start: () => new AsyncQueue<AgentEvent>(),
      interrupt: () => undefined,
      dispose: async () => undefined,
    }
    const fallback = {
      kind: 'claude' as const,
      create: vi.fn(async () => adapter),
      hasLiveSession: vi.fn(() => false),
    }
    const query = vi.fn(() => {
      throw new Error('unsupported installed CLI')
    })
    const driver = new ClaudeDriver('installed.exe', { query, fallback })
    expect(await driver.create(SESSION)).toBe(adapter)
    expect(fallback.create).toHaveBeenCalledOnce()
    fallback.hasLiveSession.mockReturnValue(true)
    expect(await driver.create({ ...SESSION, resumeOf: 'native' })).toBe(adapter)
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('routes MCP elicitation through the existing pending-input flow', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const events: AgentEvent[] = []
    const reading = (async () => {
      for await (const event of adapter.start()) events.push(event)
    })()
    const request: Parameters<NonNullable<Options['onElicitation']>>[0] = {
      mode: 'form',
      serverName: 'test',
      message: 'Choose a target',
      requestedSchema: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['Desktop', 'Phone'] } },
      },
    }
    const response = queries[0]!.options.onElicitation!(request, {
      requestId: 'elicitation',
      signal: new AbortController().signal,
    })
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'input-requested')).toBe(true),
    )
    const input = events.find((event) => event.type === 'input-requested')!
    if (input.type !== 'input-requested') throw new Error('missing input')
    adapter.respondInput!(input.inputId, JSON.stringify({ target: 'Desktop' }))
    expect(await response).toEqual({ action: 'accept', content: { target: 'Desktop' } })
    queries[0]!.finish()
    await reading
    await adapter.dispose()
  })
  it('keeps the CLI default model and provider-default effort unset', () => {
    const options = buildClaudeOptions(
      { ...SESSION, modelId: 'default', effort: 'provider-default' },
      'claude',
    )
    expect(options.model).toBeUndefined()
    expect(options.effort).toBeUndefined()
  })
  it.each([
    { resumeOf: null },
    { modelId: 'opus' },
    { effort: 'max' },
    { permissionMode: 'full' as const },
    { runtimeEnv: { CLAUDE_CONFIG_DIR: '/another-account' } },
  ])(
    'restarts with the changed launch options without reusing the old thread: %j',
    async (change) => {
      const { driver, queries } = harness()
      const first = await driver.create(SESSION)
      const reading = collect(first)
      background(queries[0]!)
      queries[0]!.finish()
      await reading
      await first.dispose()
      const next = await driver.create({ ...SESSION, resumeOf: 'native', ...change })
      expect(next.continuesBackgroundWork?.()).toBe(false)
      expect(queries).toHaveLength(2)
      expect(queries[0]!.close).toHaveBeenCalled()
      const nextEvents = collect(next)
      queries[1]!.finish()
      await nextEvents
      await next.dispose()
    },
  )
  it('passes slash commands unchanged through streaming input', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create({
      ...SESSION,
      prompt: '/compact Keep the implementation decisions.',
    })
    await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(1))
    expect(JSON.stringify(queries[0]!.sent[0])).toContain(
      '/compact Keep the implementation decisions.',
    )
    const events = collect(adapter)
    queries[0]!.finish()
    await events
    await adapter.dispose()
  })
  it('preserves multi-select answers and plan change feedback through the existing question UI', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const events: AgentEvent[] = []
    const reading = (async () => {
      for await (const event of adapter.start()) events.push(event)
    })()
    const ask = queries[0]!.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'Targets?',
            multiSelect: true,
            options: [{ label: 'Desktop' }, { label: 'Phone' }],
          },
        ],
      },
      { requestId: 'ask', signal: new AbortController().signal, toolUseID: 'ask' },
    )
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'input-requested')).toBe(true),
    )
    const request = events.find((event) => event.type === 'input-requested')!
    if (request.type !== 'input-requested') throw new Error('missing question')
    adapter.respondInput!(request.inputId, JSON.stringify({ '0': ['Desktop', 'Phone'] }))
    expect(await ask).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Targets?': 'Desktop, Phone' } },
    })
    const plan = queries[0]!.options.canUseTool!(
      'ExitPlanMode',
      { plan: 'Do the work' },
      { requestId: 'plan', signal: new AbortController().signal, toolUseID: 'plan' },
    )
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'input-requested')).toHaveLength(2),
    )
    const planRequest = events.filter((event) => event.type === 'input-requested').at(-1)!
    if (planRequest.type !== 'input-requested') throw new Error('missing plan')
    adapter.respondInput!(
      planRequest.inputId,
      JSON.stringify({ outcome: 'cancelled', feedback: 'Include tests' }),
    )
    expect(await plan).toEqual({ behavior: 'deny', message: 'Include tests' })
    queries[0]!.finish()
    await reading
    await adapter.dispose()
  })
  it('settles an interrupt even when the SDK never delivers result, then closes the query', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const reading = collect(adapter)
    vi.useFakeTimers()
    adapter.interrupt()
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await reading).at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(queries[0]!.close).toHaveBeenCalledTimes(1)
    await adapter.dispose()
  })
  it('maps recorded SDK-compatible messages and settles at result while the query stays open', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const received = collect(adapter)
    const lines = readFileSync(
      new URL('__fixtures__/success-session.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
    for (const line of lines) queries[0]!.emit(JSON.parse(line))
    const events = await received
    expect(
      events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('helloDone — the command printed hello.')
    expect(events.some((event) => event.type === 'tool-started')).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(queries[0]!.close).not.toHaveBeenCalled()
    await adapter.dispose()
    expect(adapter.keepsBackgroundWork?.()).toBe(true)
  })

  it('sends two turns through one query, retains background tasks, and reaps only after completion', async () => {
    const { driver, queries, pool, createQuery } = harness()
    const first = await driver.create(SESSION)
    const firstEvents = collect(first)
    background(queries[0]!)
    queries[0]!.finish()
    await firstEvents
    await first.dispose()
    pool.reap(Date.now() + 60_000)
    expect(pool.has('ari')).toBe(true)
    const next = await driver.create({ ...SESSION, prompt: 'Continue', resumeOf: 'native' })
    expect(next.continuesBackgroundWork?.()).toBe(true)
    const nextEvents = collect(next)
    queries[0]!.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent',
      status: 'completed',
      summary: 'Done',
    })
    queries[0]!.finish()
    expect((await nextEvents).filter((event) => event.type === 'background-task')).toMatchObject([
      { status: 'running' },
      { status: 'completed' },
    ])
    await next.dispose()
    expect(createQuery).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(2))
    pool.reap(Date.now() + 60_000)
    expect(pool.has('ari')).toBe(false)
    expect(queries[0]!.close).toHaveBeenCalled()
  })

  it('routes autonomous results away from a newly submitted human turn', async () => {
    const { driver, queries } = harness()
    const first = await driver.create(SESSION)
    const firstEvents = collect(first)
    background(queries[0]!)
    queries[0]!.finish()
    await firstEvents
    await first.dispose()
    const next = await driver.create({ ...SESSION, resumeOf: 'native' })
    let settled = false
    const nextEvents = collect(next).then((events) => {
      settled = true
      return events
    })
    queries[0]!.finish({ origin: { kind: 'task_notification' } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(2))
    queries[0]!.finish({ user_message_uuids: [queries[0]!.sent[1]!.uuid] })
    await nextEvents
    await next.dispose()
  })

  it.each(['ask', 'allow-edits', 'full'] as const)(
    'preserves %s permission mode, model, effort, login environment and resume',
    (permissionMode) => {
      const options = buildClaudeOptions(
        {
          ...SESSION,
          permissionMode,
          effort: 'high',
          resumeOf: 'native',
          instructions: 'Ari instructions',
          runtimeEnv: { CLAUDE_CONFIG_DIR: '/profile', PATH: '/bin' },
        },
        'installed.exe',
      )
      expect(options).toMatchObject({
        pathToClaudeCodeExecutable: 'installed.exe',
        model: 'haiku',
        effort: 'high',
        resume: 'native',
        permissionMode:
          permissionMode === 'ask'
            ? 'default'
            : permissionMode === 'allow-edits'
              ? 'acceptEdits'
              : 'bypassPermissions',
        env: { CLAUDE_CONFIG_DIR: '/profile', PATH: '/bin' },
        systemPrompt: { append: 'Ari instructions' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
      })
      expect(options.allowDangerouslySkipPermissions).toBe(
        permissionMode === 'full' ? true : undefined,
      )
    },
  )

  it('answers permission requests with the original input and session-scoped suggested rules', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const events: AgentEvent[] = []
    const reading = (async () => {
      for await (const event of adapter.start()) events.push(event)
    })()
    const answer = queries[0]!.options.canUseTool!(
      'Bash',
      { command: 'echo ok' },
      {
        requestId: 'request',
        signal: new AbortController().signal,
        toolUseID: 'tool',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
            behavior: 'allow',
            destination: 'userSettings',
          },
        ],
      },
    )
    await vi.waitFor(() =>
      expect(events.find((event) => event.type === 'approval-requested')).toBeDefined(),
    )
    const approval = events.find((event) => event.type === 'approval-requested')!
    if (approval.type !== 'approval-requested') throw new Error('missing approval')
    adapter.respondApproval!(approval.approvalId, { optionId: 'always-allow' })
    expect(await answer).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo ok' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })
    queries[0]!.finish()
    await reading
    await adapter.dispose()
  })

  it('supports plan exit approval and AskUserQuestion through the existing UI events', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const events: AgentEvent[] = []
    const reading = (async () => {
      for await (const event of adapter.start()) events.push(event)
    })()
    const answer = queries[0]!.options.canUseTool!(
      'AskUserQuestion',
      {
        questions: [
          { question: 'Which target?', options: [{ label: 'Desktop' }, { label: 'Phone' }] },
        ],
      },
      { requestId: 'request', signal: new AbortController().signal, toolUseID: 'question' },
    )
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'input-requested')).toBe(true),
    )
    const question = events.find((event) => event.type === 'input-requested')!
    if (question.type !== 'input-requested') throw new Error('missing question')
    adapter.respondInput!(question.inputId, 'Desktop')
    expect(await answer).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which target?': 'Desktop' } },
    })
    const plan = queries[0]!.options.canUseTool!(
      'ExitPlanMode',
      { plan: 'Implement the fix' },
      { requestId: 'request', signal: new AbortController().signal, toolUseID: 'plan' },
    )
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'input-requested')).toHaveLength(2),
    )
    const planRequest = events.filter((event) => event.type === 'input-requested').at(-1)!
    if (planRequest.type !== 'input-requested') throw new Error('missing plan')
    expect(JSON.parse(planRequest.choicesJson!)).toMatchObject({
      kind: 'plan-approval',
      planContent: 'Implement the fix',
    })
    adapter.respondInput!(planRequest.inputId, 'approved')
    expect(await plan).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    queries[0]!.finish()
    await reading
    await adapter.dispose()
  })

  it('delivers and answers background approvals after result; abort releases the callback', async () => {
    const { driver, queries, pool } = harness()
    const events: AgentEvent[] = []
    pool.onBackground = (_id, received) => events.push(...received)
    const adapter = await driver.create(SESSION)
    const reading = collect(adapter)
    background(queries[0]!)
    queries[0]!.finish()
    await reading
    await adapter.dispose()
    const controller = new AbortController()
    const permission = queries[0]!.options.canUseTool!(
      'Write',
      { file_path: '/file' },
      { requestId: 'request', signal: controller.signal, toolUseID: 'tool' },
    )
    expect(events.some((event) => event.type === 'approval-requested')).toBe(true)
    controller.abort()
    expect(await permission).toMatchObject({ behavior: 'deny' })
    expect(pool.controls('ari')).toBeNull()
  })

  it('interrupts with SDK interrupt, settles, and reuses the query on the next turn', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const reading = collect(adapter)
    background(queries[0]!)
    adapter.interrupt()
    expect(queries[0]!.interrupt).toHaveBeenCalledTimes(1)
    queries[0]!.finish({ is_error: false })
    expect((await reading).at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(queries[0]!.stopTask).toHaveBeenCalledWith('agent')
    await adapter.dispose()
    const next = await driver.create({ ...SESSION, resumeOf: 'native' })
    expect(next.continuesBackgroundWork?.()).toBe(true)
    const nextEvents = collect(next)
    queries[0]!.finish()
    await nextEvents
    await next.dispose()
  })

  it('turns a stream crash into an error and closes the query', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create(SESSION)
    const reading = collect(adapter)
    queries[0]!.stream.end()
    expect(await reading).toMatchObject([{ type: 'error' }, { type: 'done', stopReason: 'error' }])
    expect(queries[0]!.close).toHaveBeenCalled()
    await adapter.dispose()
  })

  it('includes missing attachments on the streaming input and refuses steering after result', async () => {
    const { driver, queries } = harness()
    const adapter = await driver.create({
      ...SESSION,
      attachments: [{ id: 'img', name: 'missing.png', mimeType: 'image/png', path: null }],
    })
    await vi.waitFor(() => expect(queries[0]!.sent).toHaveLength(1))
    expect(JSON.stringify(queries[0]!.sent[0])).toContain('staged file missing')
    expect(await adapter.steer!('Check the other target')).toBe(true)
    const reading = collect(adapter)
    queries[0]!.finish()
    await reading
    expect(await adapter.steer!('too late')).toBe(false)
    await adapter.dispose()
  })
})
