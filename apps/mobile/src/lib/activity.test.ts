import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@ari/contracts/message'
import { activitySteps, activitySummary } from './activity'
import { conversationParts } from './conversation-parts'

const steps = (parts: MessagePart[], live = false): ReturnType<typeof activitySteps> =>
  activitySteps(conversationParts(parts).parts, live)
const call = (callId: string, name: string, args: unknown): MessagePart => ({
  type: 'tool-call',
  callId,
  name,
  argsJson: JSON.stringify(args),
})
const result = (callId: string, value: unknown, isError = false): MessagePart => ({
  type: 'tool-result',
  callId,
  resultJson: JSON.stringify(value),
  isError,
})

describe('agent activity as steps', () => {
  it('words a tool call as what it did and to what', () => {
    expect(
      steps([
        call('1', 'Read', { file_path: 'D:\\Projects\\Ari\\apps\\mobile\\src\\App.tsx' }),
        result('1', 'contents'),
        call('2', 'Bash', { command: 'pnpm test' }),
        result('2', 'ok'),
        call('3', 'Grep', { pattern: '#pair=', path: 'apps/mobile' }),
        result('3', '12 matches'),
      ]).map((step) => `${step.label} ${step.target}`),
    ).toEqual(['Read src/App.tsx', 'Ran pnpm test', 'Searched #pair= in apps/mobile'])
  })

  it('joins a result to its call, keeping both for the detail view', () => {
    const [step] = steps([call('1', 'Bash', { command: 'pnpm test' }), result('1', 'Tests passed')])
    expect(step).toMatchObject({ pending: false, failed: false, output: 'Tests passed' })
    expect(step?.input).toContain('"command": "pnpm test"')
  })

  it('marks a failed step, and one still waiting for its result', () => {
    const [failed, waiting] = steps([
      call('1', 'Bash', { command: 'pnpm verify' }),
      result('1', 'exit 1', true),
      call('2', 'Edit', { file_path: 'a.ts' }),
    ])
    expect(failed).toMatchObject({ failed: true, pending: false })
    expect(waiting).toMatchObject({ failed: false, pending: true, label: 'Edited' })
  })

  it('words the step in progress in the present while the agent is working', () => {
    const [done, running] = steps(
      [
        call('1', 'Read', { file_path: 'a.ts' }),
        result('1', 'x'),
        call('2', 'Edit', { path: 'b.ts' }),
      ],
      true,
    )
    expect(done?.label).toBe('Read')
    expect(running?.label).toBe('Editing')
  })

  it('shows reasoning as a step, previewed by its first line', () => {
    const [step] = steps([{ type: 'thinking', text: '**Check** the fragment.\n\nThen the store.' }])
    expect(step).toMatchObject({
      kind: 'thought',
      label: 'Thought',
      target: 'Check the fragment.',
      output: '**Check** the fragment.\n\nThen the store.',
    })
  })

  it('names a tool with nothing to show by its own name', () => {
    expect(steps([call('1', 'run_terminal_command', {})])[0]).toMatchObject({
      target: 'run terminal command',
    })
  })

  it('keeps a result whose call it never saw', () => {
    expect(steps([result('lost', 'late output')])[0]).toMatchObject({
      label: 'Result',
      output: 'late output',
    })
  })

  it('summarises a run of steps, saying when any failed', () => {
    const run = steps([
      call('1', 'Read', { path: 'a' }),
      result('1', 'x'),
      call('2', 'Bash', { command: 'x' }),
      result('2', 'no', true),
    ])
    expect(activitySummary(run)).toBe('2 steps, 1 failed')
    expect(activitySummary(run.slice(0, 1))).toBe('1 step')
  })
})
