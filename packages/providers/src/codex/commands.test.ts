import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { createCodexAppServerAdapter } from './codex-driver'
import { describeGoal, parseGoalArgs, reviewTarget } from './commands'

describe('codex command arguments', () => {
  it('reads /goal the way the Codex TUI does', () => {
    expect(parseGoalArgs('')).toEqual({ kind: 'get' })
    expect(parseGoalArgs(' Pause ')).toEqual({ kind: 'pause' })
    expect(parseGoalArgs('resume')).toEqual({ kind: 'resume' })
    expect(parseGoalArgs('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalArgs('edit')).toEqual({ kind: 'edit' })
    // Only a lone keyword is a subcommand.
    expect(parseGoalArgs('clear the build cache')).toEqual({
      kind: 'set',
      objective: 'clear the build cache',
    })
  })

  it('describes a goal for a notice', () => {
    expect(describeGoal(null)).toBe('No goal is set for this Codex thread.')
    expect(
      describeGoal({
        objective: 'Ship the beta',
        status: 'budgetLimited',
        tokenBudget: 50_000,
        tokensUsed: 51_200,
        timeUsedSeconds: 3_900,
      }),
    ).toBe(
      'Goal: Ship the beta\nStatus: limited by budget · Time used: 1h 5m · Tokens used: 51,200 of 50,000',
    )
  })

  it('reviews the uncommitted changes unless told what to review', () => {
    expect(reviewTarget('')).toEqual({ type: 'uncommittedChanges' })
    expect(reviewTarget(' the parser ')).toEqual({ type: 'custom', instructions: 'the parser' })
  })
})

// --- A scripted app-server ---------------------------------------------------

interface FakeChild {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  sent: { method: string; params: Record<string, unknown> }[]
  kill(): boolean
  on(): unknown
}

type Handler = (method: string, params: Record<string, unknown>) => unknown

function server(handler: Handler): FakeChild {
  const child: FakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    sent: [],
    kill() {
      child.killed = true
      child.stdin.end()
      child.stdout.end()
      child.stderr.end()
      return true
    },
    on: () => child,
  }
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const frame = JSON.parse(buffer.slice(0, at)) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      buffer = buffer.slice(at + 1)
      if (typeof frame.method !== 'string' || typeof frame.id !== 'number') continue
      child.sent.push({ method: frame.method, params: frame.params ?? {} })
      try {
        const result = handler(frame.method, frame.params ?? {}) ?? {}
        child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
      } catch (error) {
        child.stdout.write(
          `${JSON.stringify({ id: frame.id, error: { code: -32603, message: String(error) } })}\n`,
        )
      }
    }
  })
  return child
}

function notify(child: FakeChild, method: string, params: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify({ method, params })}\n`)
}

const base = (method: string): unknown =>
  method === 'initialize'
    ? { userAgent: 'codex/test' }
    : method === 'thread/start' || method === 'thread/resume'
      ? { thread: { id: 'thr_1' } }
      : undefined

const SESSION: AdapterSession = {
  sessionId: 'ari_1',
  workspacePath: '/w',
  prompt: '',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}

async function drain(adapter: ProviderAdapter, guardMs = 4000): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  const iterator = adapter.start()[Symbol.asyncIterator]()
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`drain timed out: ${JSON.stringify(out)}`)), guardMs),
      ),
    ])
    if (next.done) return out
    out.push(next.value)
  }
}

const tick = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('codex commands over the app-server', () => {
  it('answers /goal from thread/goal/get without a turn or a resumable thread', async () => {
    const child = server((method) => (method === 'thread/goal/get' ? { goal: null } : base(method)))
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/goal', command: { name: 'goal', args: '' } },
      () => child,
    )
    const events = await drain(adapter)
    expect(child.sent.map((frame) => frame.method)).toEqual([
      'initialize',
      'thread/start',
      'thread/goal/get',
    ])
    // A thread that never ran a turn has no rollout: it is not handed back to resume.
    expect(events).toEqual([
      { type: 'notice', message: 'No goal is set for this Codex thread.' },
      { type: 'done' },
    ])
  })

  it('runs a typed /goal clear on a resumed thread even when the engine did not mark it', async () => {
    const child = server(base)
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/goal clear', resumeOf: 'thr_1' },
      () => child,
    )
    const events = await drain(adapter)
    expect(child.sent.at(-1)).toEqual({
      method: 'thread/goal/clear',
      params: { threadId: 'thr_1', origin: 'user' },
    })
    expect(events).toEqual([
      { type: 'session-ref', ref: 'thr_1' },
      { type: 'notice', message: 'Goal cleared.' },
      { type: 'done' },
    ])
  })

  it('stays on while Codex pursues a new goal, across its own turns', async () => {
    const goal = { objective: 'Ship it', status: 'active', tokensUsed: 0, tokenBudget: null }
    const child = server((method) => (method === 'thread/goal/set' ? { goal } : base(method)))
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/goal Ship it', command: { name: 'goal', args: 'Ship it' } },
      () => child,
    )
    const drained = drain(adapter)
    await tick()
    expect(child.sent.at(-1)).toEqual({
      method: 'thread/goal/set',
      params: { threadId: 'thr_1', status: 'active', origin: 'user', objective: 'Ship it' },
    })
    for (const turnId of ['t1', 't2']) {
      notify(child, 'turn/started', { threadId: 'thr_1', turn: { id: turnId } })
      notify(child, 'item/completed', {
        threadId: 'thr_1',
        turnId,
        item: { id: `m-${turnId}`, type: 'agentMessage', text: `work ${turnId}` },
      })
      notify(child, 'turn/completed', {
        threadId: 'thr_1',
        turn: { id: turnId, status: 'completed' },
      })
      await tick()
    }
    notify(child, 'thread/goal/updated', {
      threadId: 'thr_1',
      turnId: 't2',
      goal: { ...goal, status: 'complete', tokensUsed: 900 },
    })
    const events = await drained
    expect(events.filter((event) => event.type !== 'commands')).toEqual([
      { type: 'session-ref', ref: 'thr_1' },
      { type: 'notice', message: 'Goal: Ship it\nStatus: active · Tokens used: 0' },
      { type: 'text-delta', text: 'work t1' },
      { type: 'text-delta', text: 'work t2' },
      { type: 'notice', message: 'Goal: Ship it\nStatus: complete · Tokens used: 900' },
      { type: 'done' },
    ])
  })

  it('pauses the goal when the user stops its pursuit', async () => {
    const goal = { objective: 'Ship it', status: 'active', tokensUsed: 0, tokenBudget: null }
    const child = server((method) => (method === 'thread/goal/set' ? { goal } : base(method)))
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/goal resume', resumeOf: 'thr_1' },
      () => child,
    )
    const drained = drain(adapter)
    await tick()
    notify(child, 'turn/started', { threadId: 'thr_1', turn: { id: 't1' } })
    await tick()
    adapter.interrupt()
    await tick()
    notify(child, 'turn/completed', {
      threadId: 'thr_1',
      turn: { id: 't1', status: 'interrupted' },
    })
    const events = await drained
    expect(child.sent.map((frame) => frame.method)).toEqual(
      expect.arrayContaining(['turn/interrupt']),
    )
    expect(child.sent).toContainEqual({
      method: 'thread/goal/set',
      params: { threadId: 'thr_1', status: 'paused', origin: 'user' },
    })
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
  })

  it('runs /compact as thread/compact/start and reports the compaction as a notice', async () => {
    const child = server(base)
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/compact', resumeOf: 'thr_1', command: { name: 'compact', args: '' } },
      () => child,
    )
    const drained = drain(adapter)
    await tick()
    notify(child, 'turn/started', { threadId: 'thr_1', turn: { id: 'c1' } })
    notify(child, 'item/completed', {
      threadId: 'thr_1',
      turnId: 'c1',
      item: { id: 'x', type: 'contextCompaction' },
    })
    notify(child, 'turn/completed', { threadId: 'thr_1', turn: { id: 'c1', status: 'completed' } })
    const events = await drained
    expect(child.sent.map((frame) => frame.method)).toContain('thread/compact/start')
    expect(child.sent.map((frame) => frame.method)).not.toContain('turn/start')
    expect(events).toEqual([
      { type: 'session-ref', ref: 'thr_1' },
      { type: 'notice', message: 'Codex compacted the conversation context.' },
      { type: 'done', stopReason: 'completed' },
    ])
  })

  it('runs /review as review/start and shows the findings', async () => {
    const child = server((method) =>
      method === 'review/start' ? { turn: { id: 'r1' }, reviewThreadId: 'thr_1' } : base(method),
    )
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      { ...SESSION, prompt: '/review', resumeOf: 'thr_1', command: { name: 'review', args: '' } },
      () => child,
    )
    const drained = drain(adapter)
    await tick()
    notify(child, 'item/completed', {
      threadId: 'thr_1',
      turnId: 'r1',
      item: { id: 'rv', type: 'exitedReviewMode', review: 'No issues found.' },
    })
    notify(child, 'turn/completed', { threadId: 'thr_1', turn: { id: 'r1', status: 'completed' } })
    const events = await drained
    expect(child.sent.find((frame) => frame.method === 'review/start')?.params).toEqual({
      threadId: 'thr_1',
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    })
    expect(events).toContainEqual({ type: 'text-delta', text: 'No issues found.' })
  })

  it('sends a /$skill as the skill input item Codex expects', async () => {
    const child = server((method) =>
      method === 'skills/list'
        ? { data: [{ cwd: '/w', skills: [{ name: 'imagegen', path: '/s/imagegen/SKILL.md' }] }] }
        : method === 'turn/start'
          ? { turn: { id: 's1' } }
          : base(method),
    )
    const adapter = await createCodexAppServerAdapter(
      '/bin/codex',
      {
        ...SESSION,
        prompt: '/$imagegen a red cube',
        resumeOf: 'thr_1',
        command: { name: '$imagegen', args: 'a red cube' },
      },
      () => child,
    )
    const drained = drain(adapter)
    await tick()
    notify(child, 'turn/completed', { threadId: 'thr_1', turn: { id: 's1', status: 'completed' } })
    await drained
    expect(child.sent.find((frame) => frame.method === 'turn/start')?.params).toMatchObject({
      threadId: 'thr_1',
      input: [
        { type: 'text', text: '$imagegen a red cube' },
        { type: 'skill', name: 'imagegen', path: '/s/imagegen/SKILL.md' },
      ],
    })
  })
})
