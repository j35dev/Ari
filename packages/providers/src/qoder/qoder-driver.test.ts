import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage, Daemon } from '@qoder-ai/qoder-agent-sdk'
import type { AdapterSession, Driver } from '../driver'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { AsyncQueue } from '../claude/async-queue'
import { ClaudeSessionPool } from '../claude/session-pool'
import { QoderDriver, buildQoderOptions, type QoderQuery } from './qoder-driver'

const session: AdapterSession = {
  sessionId: 'ari-session',
  workspacePath: '/fixture',
  prompt: 'Fixture question',
  modelId: 'default',
  permissionMode: 'ask',
  resumeOf: null,
}
const packet = (value: unknown) => value as SDKMessage
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}
const pools: ClaudeSessionPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdownAll()))
})
function fake(
  options: Options,
  input: AsyncIterable<SDKUserMessage>,
  run?: (options: Options, queue: AsyncQueue<SDKMessage>, message: SDKUserMessage) => Promise<void>,
) {
  const queue = new AsyncQueue<SDKMessage>()
  const received: SDKUserMessage[] = []
  const close = vi.fn(async () => {
    queue.end()
  })
  void (async () => {
    for await (const message of input) {
      received.push(message)
      if (run) await run(options, queue, message)
      else {
        queue.push(
          packet({
            type: 'assistant',
            session_id: 'native',
            parent_tool_use_id: null,
            uuid: `a-${received.length}`,
            message: {
              id: `m-${received.length}`,
              content: [{ type: 'text', text: 'Fixture answer' }],
            },
          }),
        )
        queue.push(
          packet({
            type: 'result',
            subtype: 'success',
            session_id: 'native',
            uuid: `r-${received.length}`,
            is_error: false,
            result: 'Fixture answer',
            usage: { input_tokens: 2, output_tokens: 2 },
            total_cost_usd: 0,
          }),
        )
      }
    }
  })()
  const runtime: QoderQuery = Object.assign(queue, {
    initializationResult: async () =>
      ({ permissionMode: options.permissionMode }) as Awaited<
        ReturnType<QoderQuery['initializationResult']>
      >,
    interrupt: async () => undefined,
    close,
    supportedCommands: async () => [],
  })
  return { runtime, received, close }
}
describe('Qoder SDK driver', () => {
  it('keeps child activity and approval live after the parent settles, and stops the exact native task', async () => {
    const pool = new ClaudeSessionPool()
    pools.push(pool)
    const between: AgentEvent[] = []
    pool.onBackground = (_id, events) => between.push(...events)
    const stopTask = vi.fn(async (_id: string) => undefined)
    let permission!: Promise<unknown>
    const driver = new QoderDriver('/qodercli', {
      pool,
      query: ({ options, prompt }) => {
        const native = fake(options, prompt, async (opts, queue) => {
          queue.push(
            packet({
              type: 'assistant',
              session_id: 'native',
              parent_tool_use_id: null,
              uuid: 'launch',
              message: {
                id: 'm',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call',
                    name: 'Agent',
                    input: { description: 'Fixture child', run_in_background: true },
                  },
                ],
              },
            }),
          )
          queue.push(
            packet({
              type: 'system',
              subtype: 'task_started',
              session_id: 'native',
              uuid: 'start',
              task_id: 'native-task',
              tool_use_id: 'call',
              task_type: 'local_agent',
              description: 'Fixture child',
            }),
          )
          permission = opts.canUseTool!(
            'Bash',
            { command: 'fixture only' },
            {
              signal: new AbortController().signal,
              toolUseID: 'child-tool',
              agentID: 'native-task',
            },
          )
          queue.push(
            packet({
              type: 'result',
              subtype: 'success',
              session_id: 'native',
              uuid: 'r',
              is_error: false,
              result: '',
              usage: { input_tokens: 0, output_tokens: 0 },
              total_cost_usd: 0,
            }),
          )
          await permission
          queue.push(
            packet({
              type: 'stream_event',
              session_id: 'native',
              parent_tool_use_id: 'call',
              uuid: 'child',
              event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Child report.' },
              },
            }),
          )
        })
        native.runtime.stopTask = stopTask
        return native.runtime
      },
    })
    const adapter = await driver.create(session)
    const events = await collect(adapter.start())
    const approval = events.find((event) => event.type === 'approval-requested')!
    expect(approval).toMatchObject({
      type: 'approval-requested',
      // The callback may arrive before the queued task-start has been mapped.
      // Preserve its native identity; the task report exposes that same alias.
      taskId: 'native-task',
      providerItemId: 'child-tool',
    })
    expect(
      events.find((event) => event.type === 'background-task' && event.nativeTaskId),
    ).toMatchObject({
      id: 'call',
      nativeTaskId: 'native-task',
      providerItemId: 'call',
    })
    expect(adapter.capabilities?.().nativeChildren).toMatchObject({
      visibility: 'full',
      inspect: true,
      stop: true,
    })
    await adapter.dispose()
    expect(adapter.keepsBackgroundWork?.()).toBe(true)
    expect(pool.stopSubagents(session.sessionId)).toBe(1)
    expect(stopTask).toHaveBeenCalledExactlyOnceWith('native-task')
    pool.controls(session.sessionId)?.respondApproval?.(approval.approvalId, 'allow')
    await expect(permission).resolves.toMatchObject({ behavior: 'allow' })
    await vi.waitFor(() =>
      expect(
        between.some(
          (event) =>
            event.type === 'subagent-activity' &&
            event.taskId === 'call' &&
            event.event.type === 'text-delta' &&
            event.event.text === 'Child report.',
        ),
      ).toBe(true),
    )
    expect(between.some((event) => event.type === 'text-delta')).toBe(false)
  })
  it('returns exact advertised permission choices to the native callback', async () => {
    let outcome: unknown
    const driver = new QoderDriver('/qodercli', {
      pool: null,
      query: ({ options, prompt }) =>
        fake(options, prompt, async (opts, queue) => {
          outcome = await opts.canUseTool!(
            'Bash',
            { command: 'fixture command' },
            {
              signal: new AbortController().signal,
              toolUseID: 'tool',
              permissionOptions: [
                { outcome: 'proceed_once', name: 'Once', allowed: true },
                { outcome: 'proceed_always_and_save', name: 'Save rule', allowed: true },
                { outcome: 'cancel', name: 'Deny', allowed: false },
              ],
            },
          )
          queue.push(
            packet({
              type: 'result',
              subtype: 'success',
              session_id: 'native',
              uuid: 'r',
              is_error: false,
              result: '',
              usage: { input_tokens: 0, output_tokens: 0 },
              total_cost_usd: 0,
            }),
          )
        }).runtime,
    })
    const adapter = await driver.create(session)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    let approval: Extract<AgentEvent, { type: 'approval-requested' }> | undefined
    while (!approval) {
      const next = await iterator.next()
      if (next.done) throw new Error('Missing native permission request')
      const event = next.value
      if (event?.type === 'approval-requested') approval = event
    }
    expect(approval.options.map((option) => option.optionId)).toEqual([
      'proceed_once',
      'proceed_always_and_save',
      'cancel',
    ])
    adapter.respondApproval?.(approval.approvalId, { optionId: 'proceed_always_and_save' })
    await collect({ [Symbol.asyncIterator]: () => iterator })
    await adapter.dispose()
    expect(outcome).toMatchObject({ behavior: 'allow', permissionScope: 'persist' })
  })
  it('answers native questions without treating them as tool approvals', async () => {
    let outcome: unknown
    const driver = new QoderDriver('/qodercli', {
      pool: null,
      query: ({ options, prompt }) =>
        fake(options, prompt, async (opts, queue) => {
          outcome = await opts.canUseTool!(
            'AskUserQuestion',
            {
              questions: [
                { question: 'Which fixture?', options: [{ label: 'A' }, { label: 'B' }] },
              ],
            },
            { signal: new AbortController().signal, toolUseID: 'question' },
          )
          queue.push(
            packet({
              type: 'result',
              subtype: 'success',
              session_id: 'native',
              uuid: 'r',
              is_error: false,
              result: '',
              usage: { input_tokens: 0, output_tokens: 0 },
              total_cost_usd: 0,
            }),
          )
        }).runtime,
    })
    const adapter = await driver.create(session)
    const iterator = adapter.start()[Symbol.asyncIterator]()
    let question: Extract<AgentEvent, { type: 'input-requested' }> | undefined
    while (!question) {
      const next = await iterator.next()
      if (next.done) throw new Error('Missing native question')
      const event = next.value
      if (event?.type === 'input-requested') question = event
    }
    adapter.respondInput?.(question.inputId, JSON.stringify({ answers: { '0': 'A' } }))
    await collect({ [Symbol.asyncIterator]: () => iterator })
    await adapter.dispose()
    expect(outcome).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which fixture?': 'A' } },
    })
  })
  it('Stop releases an unfinished turn and closes its SDK process', async () => {
    let native!: ReturnType<typeof fake>
    const driver = new QoderDriver('/qodercli', {
      pool: null,
      query: ({ options, prompt }) =>
        (native = fake(options, prompt, async () => {
          await Promise.resolve()
        })).runtime,
    })
    const adapter = await driver.create(session)
    adapter.interrupt()
    const events = await collect(adapter.start())
    await adapter.dispose()
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'interrupted' })
    expect(native.close).toHaveBeenCalled()
  })
  it('uses the detected CLI, explicit permissions and isolated account environment', () => {
    const env = { PATH: '/fixture/bin', QODER_CONFIG_DIR: '/fixture/account' }
    const options = buildQoderOptions(
      {
        ...session,
        runtimeEnv: env,
        permissionMode: 'full',
        instructions: 'Ari fixture instructions',
        resumeOf: 'native',
      },
      '/qodercli',
    )
    expect(options).toMatchObject({
      pathToQoderCLIExecutable: '/qodercli',
      env,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      includeShellProgress: true,
      resume: 'native',
      systemPrompt: { preset: 'qodercli', append: 'Ari fixture instructions' },
    })
  })
  it('owns and closes separate daemons for separate account environments', async () => {
    const stops = [
      vi.fn(async () => {
        await Promise.resolve()
      }),
      vi.fn(async () => {
        await Promise.resolve()
      }),
    ]
    let index = 0
    const start = vi.fn(async () => {
      await Promise.resolve()
      return { stop: stops[index++] } as unknown as Daemon
    })
    const create = vi.fn(
      ({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) =>
        fake(options, prompt).runtime,
    )
    const driver = new QoderDriver('/qodercli', { pool: null, startDaemon: start, query: create })
    for (const account of ['a', 'b']) {
      const adapter = await driver.create({
        ...session,
        sessionId: account,
        runtimeEnv: { QODER_CONFIG_DIR: `/fixture/${account}` },
      })
      await collect(adapter.start())
      await adapter.dispose()
    }
    expect(start).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ env: { QODER_CONFIG_DIR: '/fixture/a' } }),
    )
    expect(start).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ env: { QODER_CONFIG_DIR: '/fixture/b' } }),
    )
    expect(create.mock.calls[0]?.[0].options.env).toBeUndefined()
    expect(create.mock.calls[1]?.[0].options.env).toBeUndefined()
    stops.forEach((stop) => expect(stop).toHaveBeenCalledOnce())
  })
  it('streams a turn, resumes its native session and reuses the parked SDK process', async () => {
    const pool = new ClaudeSessionPool()
    pools.push(pool)
    let runtime!: ReturnType<typeof fake>
    const create = vi.fn(
      ({ options, prompt }: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) =>
        (runtime = fake(options, prompt)).runtime,
    )
    const driver = new QoderDriver('/qodercli', { pool, query: create })
    const first = await driver.create(session)
    const events = await collect(first.start())
    expect(
      events.some((event) => event.type === 'text-delta' && event.text === 'Fixture answer'),
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'completed' })
    await first.dispose()
    expect(pool.has(session.sessionId)).toBe(true)
    const next = await driver.create({ ...session, resumeOf: 'native', prompt: 'Follow up' })
    await collect(next.start())
    await next.dispose()
    expect(create).toHaveBeenCalledTimes(1)
    expect(runtime.received).toHaveLength(2)
  })
  it('only falls back before a prompt is submitted', async () => {
    const fallback: Driver = {
      kind: 'qoder',
      create: vi.fn(async () => ({
        start: async function* () {},
        interrupt() {},
        dispose: async () => {},
      })),
    }
    let native!: ReturnType<typeof fake>
    const driver = new QoderDriver('/qodercli', {
      pool: null,
      fallback,
      query: ({ options, prompt }) => {
        native = fake(options, prompt)
        native.runtime.initializationResult = async () => {
          throw new Error('startup fixture failure')
        }
        return native.runtime
      },
    })
    await driver.create(session)
    expect(native.received).toHaveLength(0)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Inspect a mock; the provider method is not invoked here.
    expect(fallback.create).toHaveBeenCalledTimes(1)
    expect(native.close).toHaveBeenCalled()
  })
  it('does not resubmit a failed SDK turn through ACP', async () => {
    const fallback: Driver = { kind: 'qoder', create: vi.fn() }
    const driver = new QoderDriver('/qodercli', {
      pool: null,
      fallback,
      query: ({ options, prompt }) =>
        fake(options, prompt, async (_opts, queue) => {
          queue.push(
            packet({
              type: 'result',
              subtype: 'error_during_execution',
              session_id: 'native',
              uuid: 'error',
              is_error: true,
              errors: ['Fixture error'],
              usage: { input_tokens: 1, output_tokens: 0 },
              total_cost_usd: 0,
            }),
          )
        }).runtime,
    })
    const adapter = await driver.create(session)
    const events = await collect(adapter.start())
    await adapter.dispose()
    expect(events.some((event) => event.type === 'error')).toBe(true)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Inspect a mock; the provider method is not invoked here.
    expect(fallback.create).not.toHaveBeenCalled()
  })
  it('keeps existing live ACP sessions on their current transport', async () => {
    const fallback: Driver = {
      kind: 'qoder',
      hasLiveSession: () => true,
      create: vi.fn(async () => ({
        start: async function* () {},
        interrupt() {},
        dispose: async () => {},
      })),
    }
    const create = vi.fn()
    await new QoderDriver('/qodercli', { fallback, query: create }).create(session)
    expect(create).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Inspect a mock; the provider method is not invoked here.
    expect(fallback.create).toHaveBeenCalledOnce()
  })
  it('forwards explicit effort through the supported SDK model policy without changing child model settings', () => {
    const options = buildQoderOptions({ ...session, effort: 'high' }, '/qodercli')
    expect(
      options.resolveModel?.({
        purpose: 'main',
        sessionId: 'native',
        turnIndex: 0,
        availableModels: [],
      }),
    ).toEqual({ parameters: { reasoningEffort: 'high' } })
    expect(
      options.resolveModel?.({
        purpose: 'utility',
        sessionId: 'native',
        turnIndex: 0,
        availableModels: [],
      }),
    ).toBeUndefined()
  })
})
