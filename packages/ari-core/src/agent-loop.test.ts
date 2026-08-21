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
        tool?.execute({ path: '../outside.txt', content: 'x' }, { workspacePath: dir }),
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
      await expect(
        tool?.execute(
          { path: 'f.txt', oldString: 'a', newString: 'z' },
          { workspacePath: dir },
        ),
      ).rejects.toThrow(/2 times/)
      await tool?.execute(
        { path: 'f.txt', oldString: 'b', newString: 'c' },
        { workspacePath: dir },
      )
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
