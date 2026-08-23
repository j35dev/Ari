import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from './agent-loop'
import { findTool } from './tools'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ChatMessage } from './protocols/openai-chat'

async function roundFrom(responses: ChatMessage[][]): Promise<
  (messages: ChatMessage[]) => AsyncGenerator<AgentEvent>
> {
  let call = 0
  return async function* () {
    const response = responses[Math.min(call++, responses.length - 1)] ?? []
    for (const message of response) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const t of message.toolCalls) {
          yield {
            type: 'tool-started',
            callId: t.id,
            name: t.name,
            argsJson: t.argsJson,
          }
        }
      } else if (message.role === 'assistant') {
        yield { type: 'text-delta', text: message.content }
      }
    }
    yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
    yield { type: 'done' }
  }
}

describe('agent loop', () => {
  it('executes a tool round-trip and finishes with text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-loop-'))
    try {
      await writeFile(join(dir, 'note.txt'), 'hello from file', 'utf8')
      const round = await roundFrom([
        [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'c1', name: 'read_file', argsJson: JSON.stringify({ path: 'note.txt' }) },
            ],
          },
        ],
        [{ role: 'assistant', content: 'The file says hello.' }],
      ])
      const events = []
      for await (const e of runAgentLoop({
        round,
        systemPrompt: 's',
        userPrompt: 'read the note',
        workspacePath: dir,
      })) {
        events.push(e)
      }
      const types = events.map((e) => e.type)
      expect(types).toContain('tool-completed')
      expect(types[types.length - 1]).toBe('done')
      const text = events
        .filter((e) => e.type === 'text-delta')
        .map((e) => (e.type === 'text-delta' ? e.text : ''))
        .join('')
      expect(text).toContain('hello')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('jailed tools reject path escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-jail-'))
    try {
      const tool = findTool('write_file')
      expect(tool).toBeDefined()
      await expect(
        tool?.execute(
          { path: '../outside.txt', content: 'x' },
          { workspacePath: dir, permissionMode: 'full' },
        ),
      ).rejects.toThrow(/escapes workspace/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('edit_file requires a unique match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-edit-'))
    try {
      await writeFile(join(dir, 'f.txt'), 'a b a', 'utf8')
      const tool = findTool('edit_file')
      const ctx = { workspacePath: dir, permissionMode: 'full' as const }
      await expect(
        tool?.execute({ path: 'f.txt', oldString: 'a', newString: 'z' }, ctx),
      ).rejects.toThrow(/2 times/)
      await tool?.execute({ path: 'f.txt', oldString: 'b', newString: 'c' }, ctx)
      expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe('a c a')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('unknown tools surface as errored results, not crashes', async () => {
    const round = await roundFrom([
      [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'x', name: 'does_not_exist', argsJson: '{}' }],
        },
      ],
      [{ role: 'assistant', content: 'ok' }],
    ])
    const events = []
    for await (const e of runAgentLoop({
      round,
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
    })) {
      events.push(e)
    }
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type === 'tool-completed') {
      expect(completed.isError).toBe(true)
      expect(completed.resultJson).toContain('unknown tool')
    } else {
      throw new Error('expected tool-completed')
    }
  })
})

describe('permission modes', () => {
  async function collect(
    options: Parameters<typeof runAgentLoop>[0],
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const e of runAgentLoop(options)) events.push(e)
    return events
  }

  function bashRound(command: string) {
    return roundFrom([
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'bash', argsJson: JSON.stringify({ command }) }],
        },
      ],
      [{ role: 'assistant', content: 'finished' }],
    ])
  }

  it('ask blocks bash without executing the command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-ask-'))
    try {
      const events = await collect({
        round: await bashRound('echo side-effect> marker.txt'),
        systemPrompt: 's',
        userPrompt: 'u',
        workspacePath: dir,
        permissionMode: 'ask',
      })
      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      expect(completed.isError).toBe(true)
      expect(completed.resultJson).toContain("blocked by permission mode 'ask'")
      // The command never ran: no marker file exists.
      await expect(readFile(join(dir, 'marker.txt'), 'utf8')).rejects.toThrow()
      expect(events.some((e) => e.type === 'approval-requested')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('an absent mode behaves as ask (fail-closed)', async () => {
    const events = await collect({
      round: await bashRound('echo hi'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
    })
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(true)
    expect(completed.resultJson).toContain("blocked by permission mode 'ask'")
  })

  it('allow-edits permits file edits but still blocks bash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-edits-'))
    try {
      await writeFile(join(dir, 'f.txt'), 'alpha beta', 'utf8')
      const round = await roundFrom([
        [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'e1',
                name: 'edit_file',
                argsJson: JSON.stringify({ path: 'f.txt', oldString: 'alpha', newString: 'omega' }),
              },
              { id: 'b1', name: 'bash', argsJson: JSON.stringify({ command: 'echo nope' }) },
            ],
          },
        ],
        [{ role: 'assistant', content: 'done' }],
      ])
      const events = await collect({
        round,
        systemPrompt: 's',
        userPrompt: 'u',
        workspacePath: dir,
        permissionMode: 'allow-edits',
      })
      const results = events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      const edit = results.find((r) => r.callId === 'e1')
      const bash = results.find((r) => r.callId === 'b1')
      expect(edit?.isError).toBe(false)
      expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe('omega beta')
      expect(bash?.isError).toBe(true)
      expect(bash?.resultJson).toContain("blocked by permission mode 'allow-edits'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('full allows bash to run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-full-'))
    try {
      const events = await collect({
        round: await bashRound('echo ran-free'),
        systemPrompt: 's',
        userPrompt: 'u',
        workspacePath: dir,
        permissionMode: 'full',
      })
      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      expect(completed.isError).toBe(false)
      expect(completed.resultJson).toContain('ran-free')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a configured allowlist still denies non-matching calls even in full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-list-'))
    try {
      const events = await collect({
        round: await roundFrom([
          [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'w1',
                  name: 'write_file',
                  argsJson: JSON.stringify({ path: 'evil.txt', content: 'x' }),
                },
              ],
            },
          ],
          [{ role: 'assistant', content: 'done' }],
        ]),
        systemPrompt: 's',
        userPrompt: 'u',
        workspacePath: dir,
        permissionMode: 'full',
        allowlist: [{ tool: 'write_file', pattern: 'docs/**' }],
      })
      const completed = events.find((e) => e.type === 'tool-completed')
      if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
      expect(completed.isError).toBe(true)
      expect(completed.resultJson).toContain('blocked by permission allowlist')
      await expect(readFile(join(dir, 'evil.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('mode-gated calls park on requestApproval; denial names the mode', async () => {
    const decisions: string[] = []
    const events = await collect({
      round: await bashRound('echo parked'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'ask',
      requestApproval: async (request) => {
        decisions.push(request.toolName)
        expect(request.approvalId).toBeTruthy()
        return 'deny'
      },
    })
    const requested = events.find((e) => e.type === 'approval-requested')
    expect(requested).toBeDefined()
    if (requested?.type === 'approval-requested') {
      expect(requested.toolName).toBe('bash')
      expect(requested.summaryJson).toContain('echo parked')
    }
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(true)
    expect(completed.resultJson).toContain("denied by user under permission mode 'ask'")
    expect(decisions).toEqual(['bash'])
  })

  it('an approved call runs exactly once', async () => {
    let approvals = 0
    const events = await collect({
      round: await bashRound('echo approved-run'),
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'ask',
      requestApproval: async () => {
        approvals++
        return 'allow'
      },
    })
    expect(approvals).toBe(1)
    const completed = events.find((e) => e.type === 'tool-completed')
    if (completed?.type !== 'tool-completed') throw new Error('expected tool-completed')
    expect(completed.isError).toBe(false)
    expect(completed.resultJson).toContain('approved-run')
  })

  it('always-allow clears later calls of the same tool without re-prompting', async () => {
    let approvals = 0
    let responses = 0
    const round = async function* (): AsyncGenerator<AgentEvent> {
      const current = responses++
      if (current > 1) {
        yield { type: 'text-delta', text: 'all done' }
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
        yield { type: 'done' }
        return
      }
      yield {
        type: 'tool-started',
        callId: current === 0 ? 'b1' : 'b2',
        name: 'bash',
        argsJson: JSON.stringify({ command: current === 0 ? 'echo first' : 'echo second' }),
      }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: null }
      yield { type: 'done' }
    }
    const events = await collect({
      round,
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      permissionMode: 'ask',
      requestApproval: async () => {
        approvals++
        return 'always-allow'
      },
    })
    expect(approvals).toBe(1)
    const completions = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
    )
    expect(completions.map((c) => c.isError)).toEqual([false, false])
    expect(completions[0]?.resultJson).toContain('first')
    expect(completions[1]?.resultJson).toContain('second')
  })

  it('retries an empty round and completes on the next attempt', async () => {
    let calls = 0
    const round = async function* (): AsyncGenerator<AgentEvent> {
      calls++
      if (calls === 1) {
        // Whitespace-only deltas count as empty.
        yield { type: 'text-delta', text: '  \n' }
        yield { type: 'usage', inputTokens: 7, outputTokens: 0, costUsd: null }
        yield { type: 'done' }
        return
      }
      yield { type: 'text-delta', text: 'recovered' }
      yield { type: 'usage', inputTokens: 1, outputTokens: 2, costUsd: null }
      yield { type: 'done' }
    }
    const events = await collect({
      round,
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
    })
    expect(calls).toBe(2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'text-delta')).toHaveLength(1)
    // The empty attempt's usage must not be counted.
    const usages = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
    expect(usages.map((u) => u.inputTokens)).toEqual([1])
  })

  it('fails visibly after exhausting empty-response retries', async () => {
    let calls = 0
    const round = async function* (): AsyncGenerator<AgentEvent> {
      calls++
      yield { type: 'done' }
    }
    const events = await collect({
      round,
      systemPrompt: 's',
      userPrompt: 'u',
      workspacePath: '.',
      emptyResponseRetries: 2,
    })
    expect(calls).toBe(3)
    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    if (error?.type === 'error') {
      expect(error.message).toContain('empty response (3 attempts)')
    }
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('an empty retry still executes tool calls that arrive on the next attempt', async () => {
    let calls = 0
    const round = async function* (): AsyncGenerator<AgentEvent> {
      calls++
      if (calls === 2) {
        yield {
          type: 'tool-started',
          callId: 't1',
          name: 'read_file',
          argsJson: JSON.stringify({ path: 'note.txt' }),
        }
        yield { type: 'done' }
        return
      }
      yield { type: 'done' }
    }
    const dir = await mkdtemp(join(tmpdir(), 'ari-loop-'))
    try {
      await writeFile(join(dir, 'note.txt'), 'payload', 'utf8')
      const events = await collect({
        round,
        systemPrompt: 's',
        userPrompt: 'u',
        workspacePath: dir,
      })
      // Round 1 empty → retry; round 2 requests the tool; round 3+ answer
      // empties exhaust the default retry budget and fail visibly.
      expect(calls).toBe(5)
      const completed = events.find((e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed')
      expect(completed?.resultJson).toContain('payload')
      expect(events.some((e) => e.type === 'error' && e.message.includes('empty response'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
