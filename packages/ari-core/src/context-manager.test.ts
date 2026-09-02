import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_CHARS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  TRIMMED_TOOL_RESULTS_PLACEHOLDER,
  trimMessages,
} from './context-manager'
import type { ChatMessage } from './protocols/openai-chat'

const system: ChatMessage = { role: 'system', content: 'sys' }
const user: ChatMessage = { role: 'user', content: 'user-prompt' }

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text }
}

function assistantWithCalls(id: string, ...names: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: names.map((name, i) => ({ id: `${id}_${i}`, name, argsJson: '{}' })),
  }
}

function tool(callId: string, result: string): ChatMessage {
  return { role: 'tool', content: result, toolCallId: callId }
}

/** A long single-turn history like the agent loop builds it. */
function loopHistory(rounds: number, resultChars: number): ChatMessage[] {
  const messages: ChatMessage[] = [system, user]
  for (let round = 0; round < rounds; round++) {
    messages.push(assistantWithCalls(`c${round}`, 'read'))
    messages.push(tool(`c${round}_0`, 'r'.repeat(resultChars)))
  }
  messages.push(assistant('final answer'))
  return messages
}

describe('trimMessages', () => {
  it('returns equivalent messages when everything fits', () => {
    const messages = [system, user, assistant('hi'), assistant('done')]
    expect(trimMessages(messages, 100_000)).toEqual(messages)
  })

  it('always keeps the system prompt and the latest user message', () => {
    const messages = [
      system,
      user,
      assistantWithCalls('a', 'bash'),
      tool('a_0', 'x'.repeat(500)),
      user,
    ]
    const trimmed = trimMessages(messages, 10)
    expect(trimmed[0]).toEqual(system)
    expect(trimmed.at(-1)).toEqual({ role: 'user', content: 'user-prompt' })
    expect(trimmed).not.toContainEqual(tool('a_0', 'x'.repeat(500)))
  })

  it('prefers newest history when trimming a long tool loop', () => {
    const messages = loopHistory(5, 400)
    const trimmed = trimMessages(messages, 1_200)
    const contents = trimmed.map((m) => m.content)

    expect(trimmed[0]).toEqual(system)
    expect(contents).toContain(TRIMMED_TOOL_RESULTS_PLACEHOLDER)
    // oldest rounds are gone, the newest survive
    expect(contents.join('\n')).not.toContain('c0_0')
    expect(trimmed).toContainEqual(tool('c4_0', 'r'.repeat(400)))
    expect(contents).toContain('final answer')
    // pairing intact: every kept call has its result
    const calls = trimmed.flatMap((m) => m.toolCalls ?? [])
    expect(calls.map((c) => c.id)).toEqual(['c3_0', 'c4_0'])
  })

  it('collapses consecutive dropped tool results into one placeholder', () => {
    const big: ChatMessage[] = [
      system,
      user,
      assistantWithCalls('k', 'read', 'read'),
      tool('k_0', 'a'.repeat(300)),
      tool('k_1', 'b'.repeat(300)),
      assistant('midpoint'),
    ]
    const trimmed = trimMessages(big, 60)
    expect(trimmed.filter((m) => m.content === TRIMMED_TOOL_RESULTS_PLACEHOLDER)).toHaveLength(1)
    expect(trimmed).not.toContainEqual(assistantWithCalls('k', 'read', 'read'))
    expect(trimmed).toContainEqual(assistant('midpoint'))
  })

  it('emits separate placeholders for runs separated by kept messages', () => {
    const smallA: ChatMessage[] = [
      system,
      user,
      assistantWithCalls('p', 'glob'),
      tool('p_0', 'p'.repeat(50)),
      assistant('keep me'),
      assistantWithCalls('q', 'glob'),
      tool('q_0', 'q'.repeat(50)),
    ]
    // budget keeps the middle assistant turn but both tool units overflow
    const trimmed = trimMessages(smallA, 30)
    const placeholders = trimmed.filter((m) => m.content === TRIMMED_TOOL_RESULTS_PLACEHOLDER)
    expect(placeholders.length).toBeGreaterThanOrEqual(2)
    expect(trimmed).toContainEqual(assistant('keep me'))
  })

  it('never splits an assistant tool call from its results', () => {
    const messages = loopHistory(4, 200)
    const trimmed = trimMessages(messages, 700)
    const keptCallIds = new Set(trimmed.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []))
    for (const message of trimmed) {
      if (message.role === 'tool') {
        expect(keptCallIds.has(message.toolCallId ?? '')).toBe(true)
      }
    }
  })

  it('keeps the pinned latest-user unit even when it exceeds the whole budget', () => {
    const giantUser: ChatMessage = { role: 'user', content: 'g'.repeat(5_000) }
    const messages = [system, user, assistant('old'), giantUser]
    const trimmed = trimMessages(messages, 5)
    expect(trimmed).toContain(system)
    expect(trimmed).toContain(giantUser)
    expect(trimmed).not.toContainEqual(assistant('old'))
    expect(trimmed).not.toContainEqual(user)
  })

  it('does not mutate its input', () => {
    const messages = loopHistory(3, 300)
    const snapshot = structuredClone(messages)
    trimMessages(messages, 500)
    expect(messages).toEqual(snapshot)
  })

  it('handles histories without any user message', () => {
    const messages = [system, assistant('a'.repeat(400)), assistant('b'.repeat(400))]
    const trimmed = trimMessages(messages, 450)
    expect(trimmed).toContain(system)
    expect(trimmed).toContainEqual(assistant('b'.repeat(400)))
    expect(trimmed).not.toContainEqual(assistant('a'.repeat(400)))
  })

  it('exposes the driver default budget constant', () => {
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(500_000)
    expect(CONTEXT_WINDOW_CHARS).toBe(2_000_000)
  })
})
