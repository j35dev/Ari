import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { createAppServerProbe } from './appserver-probe'
import { CodexDriver, createCodexAppServerAdapter, threadOptions } from './codex-driver'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { createAppServerMapper } from './mapper'

function fixture(name: string): string[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

describe('codex app-server mapper', () => {
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
      'done',
    ])
    const ref = events[0]
    expect(ref?.type === 'session-ref' && ref.ref).toBe('thr_68b2')
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.inputTokens).toBe(812)
    expect(usage?.type === 'usage' && usage.outputTokens).toBe(57)
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
          item: { id: 'x', type: 'commandExecution', command: 'oops', status: 'failed', exitCode: 2 },
        },
      }),
    )
    const completed = inbound.events.find((e) => e.type === 'tool-completed')
    expect(completed?.type === 'tool-completed' && completed.isError).toBe(true)
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
    const fileEvents = inbounds.flatMap((i) =>
      i.kind === 'notification' ? i.events : [],
    )
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
    expect(
      mapper.mapLine('{"id":10,"error":{"code":404,"message":"nope"}}'),
    ).toMatchObject({ kind: 'error-response', id: 10, message: 'nope' })
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
          const result = handler(frame.method, frame.params ?? {}, frame.id)
          child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
        }
      }
      index = buffer.indexOf('\n')
    }
  })
}

function standardServer(): ServerHandler {
  return (method) => {
    if (method === 'initialize') return { userAgent: 'codex_cli_rs/test' }
    if (method === 'thread/start') {
      return { thread: { id: 'thr_live', sessionId: 'sess_live' } }
    }
    if (method === 'turn/start') return { turn: { id: 'turn_live', status: 'inProgress' } }
    return {}
  }
}

async function drain(
  adapter: ProviderAdapter,
  guardMs = 3000,
): Promise<AgentEvent[]> {
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
      threadId: 'thr_live',
      input: [{ type: 'text', text: 'say hi' }],
    })

    expect(events[0]).toEqual({ type: 'session-ref', ref: 'thr_live' })
    expect(events[events.length - 1]?.type).toBe('done')
    const kinds = new Set(events.map((e) => e.type))
    expect(kinds.has('tool-completed')).toBe(true)
    expect(kinds.has('usage')).toBe(true)
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

  it('answers parked approvals with wire decisions', async () => {
    const child = fakeChild()
    serve(child, standardServer())
    const adapter = await createCodexAppServerAdapter('/bin/codex', SESSION, () => child)

    const drained = drain(adapter)
    await sleep(10)
    const lines = fixtureLinesAfterHandshake('appserver-approval.jsonl')
    // Feed everything except the closing frame so approvals stay pending.
    for (const line of lines.slice(0, -1)) {
      child.stdout.write(`${line}\n`)
    }
    await sleep(30)
    adapter.respondApproval('codex-appr-it_cmd_9', 'allow')
    adapter.respondApproval('codex-appr-it_fc_1', 'deny')
    adapter.respondApproval('codex-appr-missing', 'allow')
    child.stdout.write(`${lines[lines.length - 1]}\n`)
    const events = await drained

    expect(events.some((e) => e.type === 'approval-requested')).toBe(true)
    const answers = child.sent.filter((f) => f['result'] !== undefined)
    expect(answers).toContainEqual({ id: 7, result: { decision: 'accept' } })
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
        params: { threadId: 'thr_live', turn: { id: 'turn_live', status: 'inProgress', items: [] } },
      })}\n`,
    )
    await sleep(10)
    adapter.steer('also run the tests')
    await sleep(10)
    child.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thr_live', turn: { id: 'turn_live', status: 'completed', items: [] } },
      })}\n`,
    )
    const events = await drained

    const steer = child.sent.find((f) => f['method'] === 'turn/steer')
    expect(steer?.['params']).toMatchObject({
      threadId: 'thr_live',
      expectedTurnId: 'turn_live',
      input: [{ type: 'text', text: 'also run the tests' }],
    })
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
