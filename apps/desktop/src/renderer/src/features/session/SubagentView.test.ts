import { describe, expect, it } from 'vitest'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { subagentMessages } from './SubagentView'

const TASK: BackgroundTask = {
  id: 'agent',
  kind: 'subagent',
  label: 'Survey',
  status: 'completed',
  detail: null,
  startedAt: 1,
  updatedAt: 2,
  endedAt: 2,
  prompt: 'Look around.',
  result: 'Found two files.',
}

describe('subagentMessages', () => {
  it('reads as the parent’s ask, then the work, ending in the result once', () => {
    const messages = subagentMessages('parent', 'agent', TASK, [
      { type: 'text', text: 'Looking.' },
      { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
      { type: 'text', text: 'Still looking.' },
      { type: 'text', text: 'Found two files.' },
    ])
    expect(messages.map((message) => [message.role, message.origin?.kind])).toEqual([
      ['user', 'session'],
      ['assistant', undefined],
    ])
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'Look around.' }])
    expect(messages[1]?.parts).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool-call', callId: 'c1', name: 'Bash', argsJson: '{}' },
      { type: 'text', text: 'Still looking.\n\nFound two files.' },
    ])
  })

  it('shows a result the transcript never carried, as over ACP', () => {
    const messages = subagentMessages('parent', 'agent', { ...TASK, prompt: null }, [
      { type: 'tool-call', callId: 'c1', name: 'Read', argsJson: '{}' },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts.at(-1)).toEqual({ type: 'text', text: 'Found two files.' })
  })
})
