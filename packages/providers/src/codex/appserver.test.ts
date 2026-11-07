import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createAppServerProbe } from './appserver-probe'
import { CodexDriver, createCodexAppServerAdapter, threadOptions } from './codex-driver'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { getProviderCapabilities } from '../driver'
import { createAppServerMapper } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('codex app-server mapper', () => {
  it('retains wire identity and scopes item de-duplication by thread and turn', () => {
    const mapper = createAppServerMapper()
    const feed = (
      method: string,
      threadId: string,
      turnId: string,
      item: Record<string, unknown>,
    ) =>
      mapper.mapLine(
        JSON.stringify({
          method,
          params: { threadId, turnId, item, itemId: item['id'], delta: 'root delta' },
        }),
      )
    const streamed = feed('item/agentMessage/delta', 'root', 'turn-1', { id: 'same' })
    expect(streamed).toMatchObject({
      correlation: { threadId: 'root', turnId: 'turn-1', itemId: 'same' },
    })
    expect(
      feed('item/completed', 'child', 'turn-1', {
        id: 'same',
        type: 'agentMessage',
        text: 'child complete',
      }).events,
    ).toEqual([{ type: 'text-delta', text: 'child complete' }])
    expect(
      feed('item/completed', 'root', 'turn-1', {
        id: 'same',
        type: 'agentMessage',
        text: 'root delta',
      }).events,
    ).toEqual([])
    expect(
      feed('item/completed', 'root', 'turn-2', {
        id: 'same',
        type: 'agentMessage',
        text: 'next turn',
      }).events,
    ).toEqual([{ type: 'text-delta', text: 'next turn' }])
    const tool = { id: 'same-tool', type: 'commandExecution', command: 'pwd' }
    expect(feed('item/started', 'root', 'turn-1', tool).events).toHaveLength(1)
    expect(feed('item/started', 'child', 'turn-1', tool).events).toHaveLength(1)
    expect(feed('item/started', 'root', 'turn-1', tool).events).toHaveLength(0)
    expect(feed('item/started', 'root', 'turn-2', tool).events).toHaveLength(1)
  })

  it('a child turn start cannot cause resumed root history to count as new usage', () => {
    const mapper = createAppServerMapper()
    mapper.mapLine(
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'child', turn: { id: 'child-turn' } },
      }),
    )
    const counts = { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
    const events = mapper.mapLine(
      JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'root',
          tokenUsage: { total: counts, last: counts },
        },
      }),
    ).events
    expect(events).toEqual([{ type: 'context-usage', usedTokens: 105, windowTokens: null }])
  })

  it('maps the recorded turn fixture onto normalized events', () => {
    const mapper = createAppServerMapper()
    const events: AgentEvent[] = []
    for (const line of fixture('appserver-turn.jsonl')) {
      const inbound = mapper.mapLine(line)
      events.push(...inbound.events)
    }
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'session-ref',
      'tool-started',
      'tool-completed',
      'thinking-delta',
      'text-delta',
      'text-delta',
      'usage',
      'context-usage',
      'done',
    ])
    const ref = events[0]
    expect(ref?.type === 'session-ref' && ref.ref).toBe('thr_68b2')
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.inputTokens).toBe(812)
    expect(usage?.type === 'usage' && usage.outputTokens).toBe(57)
    expect(events.find((e) => e.type === 'context-usage')).toEqual({
      type: 'context-usage',
      usedTokens: 893,
      windowTokens: 272000,
    })
  })

  /** A `thread/tokenUsage/updated` frame; each triple is input, cached, output. */
  const usageUpdate = (
    mapper: ReturnType<typeof createAppServerMapper>,
    total: [number, number, number],
    last: [number, number, number],
  ): AgentEvent[] => {
    const counts = ([inputTokens, cachedInputTokens, outputTokens]: number[]) => ({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    })
    return mapper.mapLine(
      JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thr_1',
          tokenUsage: { total: counts(total), last: counts(last), modelContextWindow: 258400 },
        },
      }),
    ).events
  }
  const startTurn = (mapper: ReturnType<typeof createAppServerMapper>): void => {
    mapper.mapLine(
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_1' } },
      }),
    )
  }

  it('does not recount the history a resumed thread restates before its turn', () => {
    // Recorded from a real journal: the second turn opened by restating the
    // first turn's single call, before any new one.
    const mapper = createAppServerMapper()
    const restated = usageUpdate(mapper, [20609, 6912, 14], [20609, 6912, 14])
    expect(restated).toEqual([{ type: 'context-usage', usedTokens: 20623, windowTokens: 258400 }])

    startTurn(mapper)
    expect(usageUpdate(mapper, [46228, 9728, 150], [25619, 2816, 136])).toContainEqual({
      type: 'usage',
      inputTokens: 25619,
      cachedInputTokens: 2816,
      outputTokens: 136,
      costUsd: null,
    })
  })

  it('counts only the growth of the cumulative thread total', () => {
    const mapper = createAppServerMapper()
    startTurn(mapper)
    // Counts recorded from a real rollout: `total` restates the whole thread.
    const update = (total: [number, number, number], last: [number, number, number]) =>
      usageUpdate(mapper, total, last)
    const events = [
      ...update([20609, 6912, 14], [20609, 6912, 14]),
      ...update([46228, 9728, 150], [25619, 2816, 136]),
      // Restated without a new call in between: nothing was spent.
      ...update([46228, 9728, 150], [25619, 2816, 136]),
    ]
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      {
        type: 'usage',
        inputTokens: 20609,
        cachedInputTokens: 6912,
        outputTokens: 14,
        costUsd: null,
      },
      {
        type: 'usage',
        inputTokens: 25619,
        cachedInputTokens: 2816,
        outputTokens: 136,
        costUsd: null,
      },
    ])
    expect(events.at(-1)).toEqual({
      type: 'context-usage',
      usedTokens: 25755,
      windowTokens: 258400,
    })
  })

  it('does not duplicate message text when both deltas and completion arrive', () => {
    const mapper = createAppServerMapper()
    const events: AgentEvent[] = []
    for (const line of fixture('appserver-turn.jsonl')) events.push(...mapper.mapLine(line).events)
    const texts = events.filter((e) => e.type === 'text-delta')
    expect(texts.length).toBe(2)
    const joined = texts.map((e) => (e.type === 'text-delta' ? e.text : '')).join('')
    expect(joined).toBe('You have one untracked file: notes.md.')
  })

  it('emits tool-started for completions without a started line', () => {
    const mapper = createAppServerMapper()
    const inbound = mapper.mapLine(
      JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 't',
          turnId: 'u',
          item: {
            id: 'it_x',
            type: 'commandExecution',
            command: 'ls',
            status: 'completed',
            exitCode: 0,
          },
        },
      }),
    )
    expect(inbound.kind === 'notification' || inbound.kind === 'server-request').toBe(true)
    expect(inbound.events.map((e) => e.type)).toEqual(['tool-started', 'tool-completed'])
  })

  it('marks failed commands as tool errors', () => {
    const mapper = createAppServerMapper()
    const inbound = mapper.mapLine(
      JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            id: 'x',
            type: 'commandExecution',
            command: 'oops',
            status: 'failed',
            exitCode: 2,
          },
        },
      }),
    )
    const completed = inbound.events.find((e) => e.type === 'tool-completed')
    expect(completed?.type === 'tool-completed' && completed.isError).toBe(true)
  })

  it('maps native and tool-produced images onto image output events', () => {
    const mapper = createAppServerMapper()
    const native = mapper.mapLine(
      JSON.stringify({
        method: 'item/completed',
        params: {
          item: { id: 'img_1', type: 'imageGeneration', status: 'completed', result: 'cG5n' },
        },
      }),
    )
    expect(native.events).toEqual([
      {
        type: 'image-output',
        dataBase64: 'cG5n',
        mimeType: 'image/png',
        name: 'generated-image.png',
      },
    ])

    const mcp = mapper.mapLine(
      JSON.stringify({
        method: 'item/completed',
        params: {
          item: {
            id: 'tool_1',
            type: 'mcpToolCall',
            tool: 'imagegen',
            status: 'completed',
            result: { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/webp' }] },
          },
        },
      }),
    )
    expect(mcp.events.map((event) => event.type)).toEqual([
      'tool-started',
      'tool-completed',
      'image-output',
    ])
  })

  it('routes approval prompts as server requests with stable ids', () => {
    const mapper = createAppServerMapper()
    const inbounds = fixture('appserver-approval.jsonl').map((l) => mapper.mapLine(l))
    const approvals = inbounds.filter((i) => i.kind === 'server-request')
    expect(approvals.length).toBe(2)

    const first = approvals[0]
    expect(first?.kind === 'server-request' && first.requestId).toBe(7)
    expect(first?.kind === 'server-request' && first.approvalId).toBe('codex-appr-it_cmd_9')

    const second = approvals[1]
    expect(second?.kind === 'server-request' && second.approvalId).toBe('codex-appr-it_fc_1')

    const requested = approvals.flatMap((a) => (a.kind === 'server-request' ? a.events : []))
    expect(requested.every((e) => e.type === 'approval-requested')).toBe(true)
  })

  it('maps file-change items and ignores unknown server methods', () => {
    const mapper = createAppServerMapper()
    const inbounds = fixture('appserver-approval.jsonl').map((l) => mapper.mapLine(l))
    const fileEvents = inbounds.flatMap((i) => (i.kind === 'notification' ? i.events : []))
    expect(fileEvents.some((e) => e.type === 'tool-started')).toBe(true)

    const unknown = mapper.mapLine(JSON.stringify({ method: 'fs/watch', params: {} }))
    expect(unknown.kind === 'notification' && unknown.events.length).toBe(0)
  })

  it('never throws on malformed frames', () => {
    const mapper = createAppServerMapper()
    const inbound = mapper.mapLine('{{{')
    expect(inbound.kind === 'notification' && inbound.events[0]?.type).toBe('error')
  })

  it('classifies response and error-response frames', () => {
    const mapper = createAppServerMapper()
    expect(mapper.mapLine('{"id":9,"result":{"ok":true}}')).toMatchObject({
      kind: 'response',
      id: 9,
    })
    expect(mapper.mapLine('{"id":10,"error":{"code":404,"message":"nope"}}')).toMatchObject({
      kind: 'error-response',
      id: 10,
      message: 'nope',
    })
  })

  it('suppresses retriable error notifications', () => {
    const mapper = createAppServerMapper()
    const retrying = mapper.mapLine(
      JSON.stringify({
        method: 'error',
        params: { error: { message: 'rate limited' }, willRetry: true },
      }),
    )
    expect(retrying.kind === 'notification' && retrying.events.length).toBe(0)
    const fatal = mapper.mapLine(
      JSON.stringify({
        method: 'error',
        params: { error: { message: 'auth missing' }, willRetry: false },
      }),
    )
    expect(fatal.events[0]?.type).toBe('error')
  })
})

describe('codex app-server probe', () => {
  it('caches verdicts per binary path', async () => {
    let runs = 0
    const probe = createAppServerProbe(async () => {
      runs += 1
      return '  app-server        [experimental] Run the app server'
    })
    expect(await probe.supportsAppServer('/bin/codex')).toBe(true)
    expect(await probe.supportsAppServer('/bin/codex')).toBe(true)
    expect(runs).toBe(1)
    expect(await probe.supportsAppServer('/bin/codex-old')).toBe(true)
    expect(runs).toBe(2)
  })

  it('reports unsupported binaries and re-checks after failed help runs', async () => {
    let fail = true
    const probe = createAppServerProbe(async () => {
      if (fail) throw new Error('boom')
      return 'no subcommands here'
    })
    expect(await probe.supportsAppServer('/bin/codex')).toBe(false)
    fail = false
    expect(await probe.supportsAppServer('/bin/codex')).toBe(false)
  })
})

describe('codex thread options', () => {
  it('maps permission modes onto sandbox/approval policy', () => {
    expect(threadOptions('ask')).toEqual({ sandbox: null, approvalPolicy: 'on-request' })
    expect(threadOptions('allow-edits')).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    expect(threadOptions('full')).toEqual({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
  })
})

// --- Adapter/driver harness -------------------------------------------------

const SESSION: AdapterSession = {
  sessionId: 'ari_1',
  workspacePath: '/w',
  prompt: 'say hi',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

type FakeChild = {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  sent: Record<string, unknown>[]
  kill(): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: FakeChild = {
    stdin,
    stdout,
    stderr,
    killed: false,
    sent: [],
    kill() {
      if (child.killed) return true
      child.killed = true
      stdin.end()
      stdout.end()
      stderr.end()
      return true
    },
    on() {
      return child
    },
  }
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) child.sent.push(JSON.parse(line) as Record<string, unknown>)
      index = buffer.indexOf('\n')
    }
  })
  return child
}

function approvalId(
  threadId: string,
  turnId: string,
  itemId: string,
  requestId: number | string,
): string {
  return `codex-appr-${encodeURIComponent(JSON.stringify([threadId, turnId, itemId, requestId]))}`
}

function emit(
  child: FakeChild,
  method: string,
  params: Record<string, unknown>,
  id?: number | string,
): void {
  child.stdout.write(`${JSON.stringify({ method, params, ...(id !== undefined ? { id } : {}) })}\n`)
}

type ServerHandler = (method: string, params: Record<string, unknown>, id: number) => unknown

/** Minimal scripted app-server: answers client requests, nothing else. */
function serve(child: FakeChild, handler: ServerHandler): void {
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) {
        const frame = JSON.parse(line) as {
          id?: number
          method?: string
          params?: Record<string, unknown>
        }
        if (typeof frame.method === 'string' && typeof frame.id === 'number') {
          try {
            const result = handler(frame.method, frame.params ?? {}, frame.id)
            child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
          } catch (error) {
            // A handler that throws models a server-side refusal, which the
            // JSON-RPC layer reports back as an error response.
            child.stdout.write(
              `${JSON.stringify({
                id: frame.id,
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              })}\n`,
            )
          }
        }
      }
      index = buffer.indexOf('\n')
    }
  })
}

function standardServer(turnId = 'turn_1'): ServerHandler {
  return (method) => {
    if (method === 'initialize') return { userAgent: 'codex_cli_rs/test' }
    if (method === 'thread/start') {
      return { thread: { id: 'thr_68b2', sessionId: 'sess_live' } }
    }
    if (method === 'turn/start') return { turn: { id: turnId, status: 'inProgress' } }
    return {}
  }
}

async function drain(adapter: ProviderAdapter, guardMs = 3000): Promise<AgentEvent[]> {
  const iterator = adapter.start()[Symbol.asyncIterator]()
  const out: AgentEvent[] = []
  while (true) {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('drain timed out')), guardMs).unref?.(),
    )
    const next = await Promise.race([iterator.next(), timer])
    if (next.done) break
    out.push(next.value)
  }
  return out
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.())

describe('codex app-server adapter', () => {
  it('runs a full turn: handshake, thread, mapped events, done', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    expect(getProviderCapabilities(adapter)).toMatchObject({
      steering: 'live',
      liveResponses: 'approvals',
      responsesAfterReconnect: false,
      nativeChildren: {
        visibility: 'lifecycle',
        inspect: false,
        message: false,
        stop: false,
        approvals: true,
      },
      nativeFork: false,
      nativeHandoff: false,
      processContinuity: 'turn-only',
      terminalStatus: 'explicit',
    })

    const drained = drain(adapter)
    await sleep(10)
    for (const line of fixtureLinesAfterHandshake('appserver-turn.jsonl')) {
      child.stdout.write(`${line}\n`)
    }
    const events = await drained

    const methods = child.sent.map((f) => f['method'])
    expect(methods).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(child.sent[1]?.['params']).toMatchObject({ cwd: '/w', approvalPolicy: 'on-request' })
    expect(child.sent[2]?.['params']).toMatchObject({
      threadId: 'thr_68b2',
      input: [{ type: 'text', text: 'say hi' }],
    })
    // No level picked: the agent keeps its own default.
    expect(child.sent[2]?.['params']).not.toHaveProperty('effort')

    expect(events[0]).toEqual({ type: 'session-ref', ref: 'thr_68b2' })
    expect(events[events.length - 1]?.type).toBe('done')
    const kinds = new Set(events.map((e) => e.type))
    expect(kinds.has('tool-completed')).toBe(true)
    expect(kinds.has('usage')).toBe(true)
  }, 10_000)

  it('carries the picked reasoning level on turn/start', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, effort: 'high' },
      () => child,
    )

    const drained = drain(adapter)
    await sleep(10)
    for (const line of fixtureLinesAfterHandshake('appserver-turn.jsonl')) {
      child.stdout.write(`${line}\n`)
    }
    await drained

    const turnStart = child.sent.find((frame) => frame['method'] === 'turn/start')
    expect(turnStart?.['params']).toMatchObject({ effort: 'high' })
  }, 10_000)

  it('resumes threads via thread/resume when resumeOf is set', async () => {
    const child = fakeChild()
    serve(child, (method) =>
      method === 'thread/resume'
        ? { thread: { id: 'thr_old', sessionId: 'sess_old' } }
        : method === 'turn/start'
          ? { turn: { id: 'turn_r', status: 'inProgress' } }
          : {},
    )
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, resumeOf: 'thr_old' },
      () => child,
    )
    const drained = drain(adapter)
    await sleep(10)
    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_old', turn: { id: 'turn_r', status: 'completed', items: [] } },
      })}\n`,
    )
    const events = await drained

    expect(child.sent.map((f) => f['method'])).toContain('thread/resume')
    expect(child.sent.find((f) => f['method'] === 'thread/resume')?.['params']).toMatchObject({
      threadId: 'thr_old',
    })
    expect(events[0]).toEqual({ type: 'session-ref', ref: 'thr_old' })
    expect(events[events.length - 1]?.type).toBe('done')
  }, 10_000)

  it('offers the decisions the server advertised and answers by exact id', async () => {
    const child = fakeChild()
    serve(child, standardServer('turn_2'))
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    const drained = drain(adapter)
    await sleep(10)
    const lines = fixtureLinesAfterHandshake('appserver-approval.jsonl')
    // Feed everything except the closing frame so approvals stay pending.
    for (const line of lines.slice(0, -1)) {
      child.stdout.write(`${line}\n`)
    }
    await sleep(30)
    // The command approval names its own decisions on the wire, including
    // `cancel`; the file-change approval names none and takes the defaults.
    adapter.respondApproval(approvalId('thr_68b2', 'turn_2', 'it_cmd_9', 7), {
      optionId: 'acceptForSession',
    })
    adapter.respondApproval(approvalId('thr_68b2', 'turn_2', 'it_fc_1', 8), 'deny')
    adapter.respondApproval('codex-appr-missing', { optionId: 'accept' })
    child.stdout.write(`${lines[lines.length - 1]}\n`)
    const events = await drained

    const offered = events
      .filter((e) => e.type === 'approval-requested')
      .map((e) => ({ approvalId: e.approvalId, ids: e.options.map((o) => o.optionId) }))
    expect(offered).toEqual([
      {
        approvalId: approvalId('thr_68b2', 'turn_2', 'it_cmd_9', 7),
        ids: ['accept', 'acceptForSession', 'decline', 'cancel'],
      },
      {
        approvalId: approvalId('thr_68b2', 'turn_2', 'it_fc_1', 8),
        ids: ['accept', 'acceptForSession', 'decline'],
      },
    ])
    const answers = child.sent.filter((f) => f['result'] !== undefined)
    // The exact id reaches the wire untouched — `acceptForSession` is not the
    // `accept` a kind-search would have picked.
    expect(answers).toContainEqual({ id: 7, result: { decision: 'acceptForSession' } })
    expect(answers).toContainEqual({ id: 8, result: { decision: 'decline' } })
    expect(answers.length).toBe(2)
  }, 10_000)

  it('steers the active turn with turn/steer', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    const drained = drain(adapter)
    await sleep(10)
    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/started',
        params: {
          threadId: 'thr_68b2',
          turn: { id: 'turn_1', status: 'inProgress', items: [] },
        },
      })}\n`,
    )
    await sleep(10)
    void adapter.steer('also run the tests')
    await sleep(10)
    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_68b2', turn: { id: 'turn_1', status: 'completed', items: [] } },
      })}\n`,
    )
    const events = await drained

    const steer = child.sent.find((f) => f['method'] === 'turn/steer')
    expect(steer?.['params']).toMatchObject({
      threadId: 'thr_68b2',
      expectedTurnId: 'turn_1',
      input: [{ type: 'text', text: 'also run the tests' }],
    })
    expect(events[events.length - 1]?.type).toBe('done')
  }, 10_000)

  it('reports a steer as undelivered when no turn is live', async () => {
    const child = fakeChild()
    // Answers turn/start without a turn id, so the adapter has no turn to
    // steer — the same state as a server that never confirms the start.
    serve(child, (method, params, id) =>
      method === 'turn/start' ? {} : standardServer()(method, params, id),
    )
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    const drained = drain(adapter)
    await sleep(10)
    // Reporting true here would let the caller discard a message the provider
    // never received.
    await expect(adapter.steer('too early')).resolves.toBe(false)
    expect(child.sent.some((f) => f['method'] === 'turn/steer')).toBe(false)
    emit(child, 'turn/started', { threadId: 'thr_68b2', turn: { id: 'turn_1' } })

    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_68b2', turn: { id: 'turn_1', status: 'completed', items: [] } },
      })}\n`,
    )
    await drained
  }, 10_000)

  it('reports a steer as undelivered when the server refuses it, without erroring the turn', async () => {
    const child = fakeChild()
    serve(child, (method, params, id) => {
      if (method === 'turn/steer') {
        throw new Error('turn not steerable')
      }
      return standardServer()(method, params, id)
    })
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    const drained = drain(adapter)
    await sleep(10)
    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/started',
        params: {
          threadId: 'thr_68b2',
          turn: { id: 'turn_1', status: 'inProgress', items: [] },
        },
      })}\n`,
    )
    await sleep(10)
    await expect(adapter.steer('also run the tests')).resolves.toBe(false)

    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_68b2', turn: { id: 'turn_1', status: 'completed', items: [] } },
      })}\n`,
    )
    const events = await drained
    // A refused steer must not surface as an error event: that would settle the
    // whole turn as `error`, which holds the queue and strands the message.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events[events.length - 1]?.type).toBe('done')
  }, 10_000)

  it('kills the process on interrupt before any active turn instead of hanging', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    adapter.interrupt()
    await sleep(10)
    expect(child.killed).toBe(true)
  }, 10_000)
})

describe('codex root and native child ownership', () => {
  const root = 'thr_68b2'
  const turn = 'turn_1'
  const start = (child: FakeChild, threadId: string, turnId: string) =>
    emit(child, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
  const complete = (child: FakeChild, threadId: string, turnId: string, status = 'completed') =>
    emit(child, 'turn/completed', {
      threadId,
      turn: { id: turnId, status, error: { message: 'child failed' } },
    })
  const message = (child: FakeChild, threadId: string, turnId: string, text: string) =>
    emit(child, 'item/agentMessage/delta', { threadId, turnId, itemId: 'shared-item', delta: text })
  const usage = (child: FakeChild, threadId: string, inputTokens: number, outputTokens: number) => {
    const counts = {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    }
    emit(child, 'thread/tokenUsage/updated', {
      threadId,
      tokenUsage: { last: counts, total: counts, modelContextWindow: 1000 },
    })
  }

  it('keeps interleaved child text, context, usage and terminals separate from root', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, root, turn)
    emit(child, 'thread/started', { thread: { id: 'child-a', preview: 'Audit files' } })
    start(child, 'child-a', 'child-turn-a')
    message(child, root, turn, 'root before; ')
    message(child, 'child-a', 'child-turn-a', 'private child text')
    usage(child, 'child-a', 800, 90)
    usage(child, root, 30, 4)
    complete(child, 'child-a', 'child-turn-a')
    start(child, 'child-b', 'child-turn-b')
    complete(child, 'child-b', 'child-turn-b', 'failed')
    // Late child text and terminals cannot affect the live root.
    complete(child, 'child-a', 'child-turn-a')
    message(child, 'child-a', 'child-turn-a', 'late private child text')
    await sleep(10)
    expect(child.killed).toBe(false)
    message(child, root, turn, 'root after')
    complete(child, root, turn)
    const events = await drained
    expect(events.filter((event) => event.type === 'session-ref')).toEqual([
      { type: 'session-ref', ref: root },
    ])
    expect(
      events
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.text)
        .join(''),
    ).toBe('root before; root after')
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 30, outputTokens: 4, cachedInputTokens: 0, costUsd: null },
    ])
    expect(events.filter((event) => event.type === 'context-usage')).toEqual([
      { type: 'context-usage', usedTokens: 34, windowTokens: 1000 },
    ])
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    const background = events.filter((event) => event.type === 'background-task')
    expect(background).toContainEqual(
      expect.objectContaining({
        id: 'child-a',
        label: 'Audit files',
        status: 'completed',
        providerThreadId: 'child-a',
        providerTurnId: 'child-turn-a',
      }),
    )
    expect(
      background.filter((event) => event.id === 'child-a' && event.status === 'completed'),
    ).toHaveLength(1)
    expect(background).toContainEqual(expect.objectContaining({ id: 'child-b', status: 'failed' }))
    expect(adapter.diagnostics()).toContainEqual(
      expect.objectContaining({
        disposition: 'child',
        threadId: 'child-a',
        turnId: 'child-turn-a',
        itemId: 'shared-item',
      }),
    )
    expect(
      adapter.diagnostics().find((frame) => frame.itemId === 'shared-item')?.rawJson,
    ).toContain('private child text')
    expect(child.killed).toBe(true)
  })

  it('preserves early root events before turn/start responds and uses the response identity', async () => {
    const child = fakeChild()
    serve(child, (method, params, id) => {
      if (method === 'thread/start') {
        emit(child, 'thread/started', { thread: { id: 'early-child', preview: 'Early worker' } })
        emit(child, 'thread/started', { threadId: root })
      }
      if (method === 'turn/start') {
        start(child, root, 'old-turn')
        complete(child, root, 'old-turn')
        start(child, root, turn)
        message(child, root, turn, 'early root answer')
        start(child, 'early-child', 'early-child-turn')
        complete(child, 'early-child', 'early-child-turn')
        usage(child, root, 12, 3)
        complete(child, root, turn)
      }
      return standardServer()(method, params, id)
    })
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const events = await drain(adapter)
    expect(events[0]).toEqual({ type: 'session-ref', ref: root })
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'early root answer' },
    ])
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'usage', inputTokens: 12, outputTokens: 3 }),
    )
    expect(adapter.diagnostics()).toContainEqual(
      expect.objectContaining({ turnId: 'old-turn', disposition: 'stale' }),
    )
    await expect(adapter.steer('after completion')).resolves.toBe(false)
  })

  it('child startup cannot redirect root steering or interruption; interruption stays explicit', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, root, turn)
    start(child, 'child-thread', 'child-turn')
    await expect(adapter.steer('run tests')).resolves.toBe(true)
    adapter.interrupt()
    await sleep(10)
    expect(child.sent.find((frame) => frame['method'] === 'turn/steer')?.['params']).toMatchObject({
      threadId: root,
      expectedTurnId: turn,
    })
    expect(child.sent.find((frame) => frame['method'] === 'turn/interrupt')?.['params']).toEqual({
      threadId: root,
      turnId: turn,
    })
    complete(child, 'child-thread', 'child-turn', 'interrupted')
    await sleep(10)
    expect(child.killed).toBe(false)
    complete(child, root, turn, 'interrupted')
    const events = await drained
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'interrupted' })
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'background-task', id: 'child-thread', status: 'stopped' }),
    )
  })

  it('late and duplicate terminals from an earlier root turn cannot close a resumed turn', async () => {
    const child = fakeChild()
    serve(child, (method, params, id) =>
      method === 'thread/resume'
        ? { thread: { id: root } }
        : standardServer('new-turn')(method, params, id),
    )
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, resumeOf: root },
      () => child,
    )
    const drained = drain(adapter)
    await sleep(10)
    start(child, root, 'new-turn')
    start(child, root, turn)
    complete(child, root, turn)
    complete(child, root, turn)
    message(child, root, turn, 'stale root text')
    emit(child, 'turn/completed', { threadId: root, turn: { status: 'completed' } })
    emit(child, 'turn/completed', { turn: { id: 'new-turn', status: 'completed' } })
    await sleep(10)
    expect(child.killed).toBe(false)
    await expect(adapter.steer('new work')).resolves.toBe(true)
    expect(child.sent.find((frame) => frame['method'] === 'turn/steer')?.['params']).toMatchObject({
      expectedTurnId: 'new-turn',
    })
    message(child, root, 'new-turn', 'current root text')
    complete(child, root, 'new-turn')
    // All these are in one burst before the consumer observes done.
    complete(child, root, 'new-turn')
    message(child, root, 'new-turn', 'late root text')
    const events = await drained
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'current root text' },
    ])
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(adapter.diagnostics().filter((frame) => frame.disposition === 'stale')).toHaveLength(7)
    expect(adapter.diagnostics()).toContainEqual(
      expect.objectContaining({ disposition: 'unscoped', threadId: null }),
    )
  })

  it('routes simultaneous root and child approvals by exact request ownership despite repeated item ids', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, root, turn)
    start(child, 'child-thread', 'child-turn')
    emit(
      child,
      'item/commandExecution/requestApproval',
      { threadId: root, turnId: turn, itemId: 'same', command: 'root command' },
      70,
    )
    emit(
      child,
      'item/commandExecution/requestApproval',
      { threadId: 'child-thread', turnId: 'child-turn', itemId: 'same', command: 'child command' },
      'child-request',
    )
    await sleep(10)
    adapter.respondApproval(
      approvalId('child-thread', 'child-turn', 'same', 'child-request'),
      'deny',
    )
    adapter.respondApproval(approvalId(root, turn, 'same', 70), { optionId: 'acceptForSession' })
    adapter.respondApproval(
      approvalId('child-thread', 'child-turn', 'same', 'child-request'),
      'allow',
    )
    expect(child.sent.filter((frame) => frame['result'] !== undefined)).toEqual([
      { id: 'child-request', result: { decision: 'decline' } },
      { id: 70, result: { decision: 'acceptForSession' } },
    ])
    // An unsupported child input request is rejected in that exact scope.
    emit(
      child,
      'item/tool/requestUserInput',
      { threadId: 'child-thread', turnId: 'child-turn', itemId: 'input' },
      72,
    )
    await sleep(10)
    expect(child.sent).toContainEqual({
      id: 72,
      error: { code: -32601, message: 'Ari does not support item/tool/requestUserInput' },
    })
    complete(child, 'child-thread', 'child-turn')
    complete(child, root, turn)
    const events = await drained
    const approvals = events.filter((event) => event.type === 'approval-requested')
    expect(approvals).toHaveLength(2)
    expect(approvals[1]).toMatchObject({
      providerThreadId: 'child-thread',
      providerTurnId: 'child-turn',
      providerItemId: 'same',
    })
    expect(JSON.parse(approvals[1]!.summaryJson)).toMatchObject({
      threadId: 'child-thread',
      turnId: 'child-turn',
      itemId: 'same',
    })
    expect(events.find((event) => event.type === 'notice')?.message).toContain(
      'Unsupported Codex request',
    )
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })

  it('expires child approvals when their turn ends and rejects stale child requests', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, 'child-thread', 'child-turn')
    emit(
      child,
      'item/fileChange/requestApproval',
      { threadId: 'child-thread', turnId: 'child-turn', itemId: 'file' },
      80,
    )
    complete(child, 'child-thread', 'child-turn')
    await sleep(10)
    adapter.respondApproval(approvalId('child-thread', 'child-turn', 'file', 80), 'allow')
    emit(
      child,
      'item/fileChange/requestApproval',
      { threadId: 'child-thread', turnId: 'child-turn', itemId: 'file' },
      81,
    )
    await sleep(10)
    expect(child.sent.filter((frame) => frame['result'] !== undefined)).toEqual([
      { id: 80, result: { decision: 'decline' } },
    ])
    expect(child.sent).toContainEqual({
      id: 81,
      error: { code: -32602, message: 'Request belongs to an inactive child turn' },
    })
    start(child, 'collab-child', 'collab-turn')
    emit(
      child,
      'item/fileChange/requestApproval',
      {
        threadId: 'collab-child',
        turnId: 'collab-turn',
        itemId: 'file',
      },
      82,
    )
    emit(child, 'item/completed', {
      threadId: root,
      turnId: turn,
      item: {
        id: 'wait',
        type: 'collabAgentToolCall',
        tool: 'wait',
        agentsStates: { 'collab-child': { status: 'completed' } },
      },
    })
    await sleep(10)
    adapter.respondApproval(approvalId('collab-child', 'collab-turn', 'file', 82), 'allow')
    expect(child.sent.filter((frame) => frame['id'] === 82)).toEqual([
      { id: 82, result: { decision: 'decline' } },
    ])
    complete(child, root, turn)
    const events = await drained
    expect(events.filter((event) => event.type === 'approval-requested')).toHaveLength(2)
  })

  it('tracks native children from root collaboration states without child notifications', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    emit(child, 'item/completed', {
      threadId: root,
      turnId: turn,
      item: {
        id: 'spawn',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['native-child'],
        prompt: 'Review provider lifecycle',
        agentsStates: { 'native-child': { status: 'running' } },
      },
    })
    await sleep(10)
    expect(child.killed).toBe(false)
    emit(child, 'item/completed', {
      threadId: root,
      turnId: turn,
      item: {
        id: 'wait',
        type: 'collabAgentToolCall',
        tool: 'wait',
        status: 'completed',
        agentsStates: { 'native-child': { status: 'completed', message: 'child report' } },
      },
    })
    complete(child, root, turn)
    const events = await drained
    expect(events.filter((event) => event.type === 'background-task')).toEqual([
      expect.objectContaining({
        id: 'native-child',
        label: 'Review provider lifecycle',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'native-child',
        label: 'Review provider lifecycle',
        status: 'completed',
      }),
    ])
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([])
    expect(
      adapter
        .diagnostics()
        .find((frame) => frame.disposition === 'native-collaboration' && frame.itemId === 'wait')
        ?.rawJson,
    ).toContain('child report')
  })

  it('ignores old native child start and completion after a newer child turn starts', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, 'child-thread', 'child-old')
    start(child, 'child-thread', 'child-new')
    start(child, 'child-thread', 'child-old')
    complete(child, 'child-thread', 'child-old')
    complete(child, 'child-thread', 'child-old')
    complete(child, root, turn)
    const events = await drained
    const background = events.filter((event) => event.type === 'background-task')
    expect(background).toHaveLength(3)
    expect(background[1]).toMatchObject({ providerTurnId: 'child-new', status: 'running' })
    expect(background[2]).toMatchObject({ providerTurnId: 'child-new', status: 'stopped' })
    expect(background.some((event) => event.status === 'completed')).toBe(false)
  })

  it('wakes the iterator on unexpected process EOF after turn/start has resolved', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    child.kill()
    const events = await drained
    expect(events.find((event) => event.type === 'error')?.message).toContain(
      'ended before completing',
    )
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
  })

  it('counts root usage after a confirmed start response even without turn/started', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    usage(child, 'child-thread', 900, 80)
    usage(child, root, 20, 2)
    complete(child, root, turn)
    const events = await drained
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 20, outputTokens: 2, cachedInputTokens: 0, costUsd: null },
    ])
  })

  it('interruption before root turn confirmation finishes as interrupted', async () => {
    const child = fakeChild()
    serve(child, (method, params, id) =>
      method === 'turn/start' ? {} : standardServer()(method, params, id),
    )
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, 'child-thread', 'child-turn')
    adapter.interrupt()
    const events = await drained
    expect(child.killed).toBe(true)
    expect(child.sent.some((frame) => frame['method'] === 'turn/interrupt')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'interrupted' })
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })

  it('ends a still-running native child when the turn-only provider process ends', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)
    const drained = drain(adapter)
    await sleep(10)
    start(child, 'child-thread', 'child-turn')
    complete(child, root, turn)
    const events = await drained
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'background-task',
        id: 'child-thread',
        status: 'stopped',
        detail: 'Provider process ended',
      }),
    )
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'completed' })
  })

  it('kills a failed startup transport before falling back to another adapter', async () => {
    const child = fakeChild()
    serve(child, (method) => {
      if (method === 'thread/start') throw new Error('thread startup refused')
      return {}
    })
    await expect(createCodexAppServerAdapter('/bin/codex', SESSION, () => child)).rejects.toThrow(
      'thread startup refused',
    )
    expect(child.killed).toBe(true)
  })
})

/** Fixture lines minus client-side traffic (requests Ari sends, responses). */
function fixtureLinesAfterHandshake(name: string): string[] {
  const clientMethods = new Set(['initialize', 'thread/start', 'thread/resume', 'turn/start'])
  return fixture(name).filter((l) => {
    const frame = JSON.parse(l) as Record<string, unknown>
    if (frame['result'] !== undefined) return false
    return !clientMethods.has(frame['method'] as string)
  })
}

function fakeLegacyChild(stdoutLines: string[]) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let killed = false
  const child = {
    stdout,
    stderr,
    pid: 4242,
    get killed() {
      return killed
    },
    kill() {
      killed = true
      stdout.end()
      stderr.end()
      return true
    },
    on(event: 'close', listener: (code: number | null) => void) {
      void Promise.resolve().then(() => {
        for (const line of stdoutLines) stdout.write(`${line}\n`)
        listener(0)
      })
      return child
    },
  }
  return child
}

describe('codex driver transport selection', () => {
  const SESSION_BASE: AdapterSession = { ...SESSION }

  it('falls back to exec --json when app-server is unsupported', async () => {
    const spawns: string[][] = []
    const driver = new CodexDriver('/bin/codex', {
      probe: { supportsAppServer: () => Promise.resolve(false) },
      spawnLegacy: (_bin, args) => {
        spawns.push(args)
        return fakeLegacyChild([
          '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
        ])
      },
    })
    const adapter = await driver.create(SESSION_BASE)
    expect(spawns.length).toBe(1)
    expect(spawns[0]?.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    const events = await drain(adapter)
    expect(events[events.length - 1]?.type).toBe('done')
    expect(adapter.respondApproval === undefined).toBe(true)
    expect(adapter.steer === undefined).toBe(true)
    expect(getProviderCapabilities(adapter)).toMatchObject({
      steering: false,
      liveResponses: false,
      processContinuity: 'turn-only',
    })
  }, 10_000)

  it('falls back when the app-server transport fails at runtime', async () => {
    const spawns: string[][] = []
    const driver = new CodexDriver('/bin/codex', {
      probe: { supportsAppServer: () => Promise.resolve(true) },
      spawnAppServer: () => {
        throw new Error('spawn exploded')
      },
      spawnLegacy: (_bin, args) => {
        spawns.push(args)
        return fakeLegacyChild([])
      },
    })
    const adapter = await driver.create(SESSION_BASE)
    expect(spawns.length).toBe(1)
    expect(typeof adapter.interrupt === 'function').toBe(true)
  }, 10_000)
})
