import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from './agent-loop'
import type { ChatMessage } from './protocols/openai-chat'
import type { Tool } from './tools'

/** A round that issues the given tool calls once, then finishes. */
function callsThenDone(calls: { callId: string; name: string; argsJson: string }[]) {
  let issued = false
  return async function* (): AsyncGenerator<AgentEvent> {
    if (!issued) {
      issued = true
      for (const call of calls) {
        yield { type: 'tool-started', callId: call.callId, name: call.name, argsJson: call.argsJson }
      }
    } else {
      yield { type: 'text-delta', text: 'ok' }
    }
    yield { type: 'done' }
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe('agent loop tool concurrency', () => {
  it('runs read-only calls concurrently while preserving result order', async () => {
    // Each call blocks on a shared gate that only opens once all three are in
    // flight, so the batch can settle only if they genuinely overlap.
    let inFlight = 0
    let peak = 0
    let open = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const slowRead: Tool = {
      name: 'slow_read',
      description: 'read-only probe',
      parameters: {},
      readOnly: true,
      execute: async (args) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        if (inFlight === 3) open()
        await gate
        inFlight--
        return `read ${String(args['path'])}`
      },
    }
    const events = await collect(
      runAgentLoop({
        round: callsThenDone([
          { callId: 'c1', name: 'slow_read', argsJson: '{"path":"a"}' },
          { callId: 'c2', name: 'slow_read', argsJson: '{"path":"b"}' },
          { callId: 'c3', name: 'slow_read', argsJson: '{"path":"c"}' },
        ]),
        systemPrompt: 's',
        userPrompt: 'read them all',
        workspacePath: process.cwd(),
        permissionMode: 'full',
        extraTools: [slowRead],
      }),
    )
    expect(peak).toBe(3)
    const completed = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
    )
    // Concurrent execution, sequential reporting: the transcript still reads in
    // the order the model asked for.
    expect(completed.map((e) => e.callId)).toEqual(['c1', 'c2', 'c3'])
    expect(completed.map((e) => JSON.parse(e.resultJson) as string)).toEqual([
      'read a',
      'read b',
      'read c',
    ])
  })

  it('runs the built-in read-only tools as one batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-par-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8')
      const events = await collect(
        runAgentLoop({
          round: callsThenDone([
            { callId: 'r1', name: 'read', argsJson: '{"path":"a.txt"}' },
            { callId: 'r2', name: 'ls', argsJson: '{}' },
            { callId: 'r3', name: 'grep', argsJson: '{"pattern":"alpha"}' },
          ]),
          systemPrompt: 's',
          userPrompt: 'explore',
          workspacePath: dir,
          permissionMode: 'full',
        }),
      )
      const completed = events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      expect(completed.map((e) => e.callId)).toEqual(['r1', 'r2', 'r3'])
      expect(completed.every((e) => !e.isError)).toBe(true)
      expect(completed[0]?.resultJson).toContain('alpha')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('never runs a guarded tool concurrently even if it claims to be read-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-guard-'))
    try {
      let approvals = 0
      const liar: Tool = {
        name: 'bash',
        description: 'claims to be safe',
        parameters: {},
        readOnly: true,
        execute: () => Promise.resolve('ran'),
      }
      const events = await collect(
        runAgentLoop({
          round: callsThenDone([{ callId: 'b1', name: 'bash', argsJson: '{"command":"ls"}' }]),
          systemPrompt: 's',
          userPrompt: 'run it',
          workspacePath: dir,
          permissionMode: 'ask',
          extraTools: [liar],
          requestApproval: () => {
            approvals++
            return Promise.resolve('deny')
          },
        }),
      )
      // The approval flow still ran, which it could not have if the call had
      // been fanned out ahead of the permission check.
      expect(approvals).toBe(1)
      const completed = events.find(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      expect(completed?.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('keeps mutating calls strictly ordered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-seq-'))
    try {
      await writeFile(join(dir, 'log.txt'), '', 'utf8')
      const events = await collect(
        runAgentLoop({
          round: callsThenDone([
            { callId: 'w1', name: 'write', argsJson: '{"path":"log.txt","content":"first"}' },
            {
              callId: 'w2',
              name: 'edit',
              argsJson: '{"path":"log.txt","edits":[{"oldText":"first","newText":"second"}]}',
            },
          ]),
          systemPrompt: 's',
          userPrompt: 'write then edit',
          workspacePath: dir,
          permissionMode: 'full',
        }),
      )
      const completed = events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      // The edit could only match "first" if the write had already landed.
      expect(completed.map((e) => e.isError)).toEqual([false, false])
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(join(dir, 'log.txt'), 'utf8')).toBe('second')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

describe('agent loop compaction hook', () => {
  it('replaces the loop history with what compact returns', async () => {
    const seen: ChatMessage[][] = []
    const events = await collect(
      runAgentLoop({
        round: async function* (messages) {
          seen.push(messages.map((m) => ({ ...m })))
          yield { type: 'text-delta', text: 'done' }
          yield { type: 'done' }
        },
        systemPrompt: 'sys',
        userPrompt: 'now',
        workspacePath: process.cwd(),
        history: [
          { role: 'user', content: 'ancient question' },
          { role: 'assistant', content: 'ancient answer' },
        ],
        compact: (messages) =>
          Promise.resolve([
            messages[0] as ChatMessage,
            { role: 'user', content: '[summary of earlier conversation]\n\nthey talked' },
            messages.at(-1) as ChatMessage,
          ]),
      }),
    )
    expect(seen[0]?.map((m) => m.content)).toEqual([
      'sys',
      '[summary of earlier conversation]\n\nthey talked',
      'now',
    ])
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('leaves history untouched when compact returns the same array', async () => {
    const seen: ChatMessage[][] = []
    await collect(
      runAgentLoop({
        round: async function* (messages) {
          seen.push(messages.map((m) => ({ ...m })))
          yield { type: 'text-delta', text: 'done' }
          yield { type: 'done' }
        },
        systemPrompt: 'sys',
        userPrompt: 'now',
        workspacePath: process.cwd(),
        history: [{ role: 'user', content: 'kept' }],
        compact: (messages) => Promise.resolve(messages),
      }),
    )
    expect(seen[0]?.map((m) => m.content)).toEqual(['sys', 'kept', 'now'])
  })
})
