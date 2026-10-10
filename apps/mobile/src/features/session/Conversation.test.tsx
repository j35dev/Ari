// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Message, MessagePart } from '@ari/contracts/message'
import { Conversation } from './Conversation'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let next = 0
function message(role: Message['role'], parts: MessagePart[], createdAt = 1): Message {
  next += 1
  return { id: `message-${next}`, sessionId: 'session-1', turnId: null, role, createdAt, parts }
}
const text = (value: string): MessagePart => ({ type: 'text', text: value })
const call = (callId: string, name: string, args: unknown): MessagePart => ({
  type: 'tool-call',
  callId,
  name,
  argsJson: JSON.stringify(args),
})
const result = (callId: string, value: string, isError = false): MessagePart => ({
  type: 'tool-result',
  callId,
  resultJson: JSON.stringify(value),
  isError,
})
const show = (messages: Message[], running = false): ReturnType<typeof render> =>
  render(<Conversation messages={messages} sessionId="session-1" running={running} />)

it('renders streamed words as one paragraph and keeps a split code fence intact', () => {
  const { container } = show([
    message(
      'assistant',
      ['This ', 'is ', 'one ', 'paragraph.', '\n\n```ts\nconst ', 'value = 1', '\n```'].map(text),
    ),
  ])
  expect(screen.getByText('This is one paragraph.')).toBeTruthy()
  expect(container.querySelectorAll('.markdown')).toHaveLength(1)
  expect(container.querySelectorAll('.markdown p')).toHaveLength(1)
  expect(container.querySelector('pre code')?.textContent).toBe('const value = 1\n')
})

it('says what each step did, with its detail one tap away', () => {
  show([
    message('assistant', [
      call('1', 'Read', { file_path: 'apps/mobile/src/App.tsx' }),
      result('1', 'export function App() {}'),
      text('The change is ready.'),
    ]),
  ])
  const step = screen.getByRole('button', { name: 'Read src/App.tsx' })
  expect(step.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('export function App() {}')).toBeNull()
  fireEvent.click(step)
  expect(screen.getByText('export function App() {}')).toBeTruthy()
  expect(screen.getByText('The change is ready.')).toBeTruthy()
})

it('folds a long finished run into a count, leaving its failures in view', () => {
  show([
    message('assistant', [
      call('1', 'Read', { path: 'a.ts' }),
      result('1', 'a'),
      call('2', 'Read', { path: 'b.ts' }),
      result('2', 'b'),
      call('3', 'Bash', { command: 'pnpm verify' }),
      result('3', 'exit 1', true),
      call('4', 'Edit', { path: 'c.ts' }),
      result('4', 'ok'),
      text('Fixed.'),
    ]),
  ])
  const summary = screen.getByRole('button', { name: '4 steps, 1 failed' })
  expect(screen.queryByRole('button', { name: 'Read a.ts' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Ran pnpm verify, failed' })).toBeTruthy()
  fireEvent.click(summary)
  expect(screen.getByRole('button', { name: 'Read a.ts' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Ran pnpm verify, failed' })).toHaveLength(1)
})

it('keeps the run the agent is still working on open, worded in the present', () => {
  show(
    [
      message('assistant', [
        call('1', 'Read', { path: 'a.ts' }),
        result('1', 'a'),
        call('2', 'Read', { path: 'b.ts' }),
        result('2', 'b'),
        call('3', 'Read', { path: 'c.ts' }),
        result('3', 'c'),
        call('4', 'Bash', { command: 'pnpm verify' }),
      ]),
    ],
    true,
  )
  expect(screen.queryByRole('button', { name: /^4 steps/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Running pnpm verify' })).toBeTruthy()
})

it('sets the user’s words apart and leaves the agent’s unboxed and unlabelled', () => {
  const { container } = show([
    message('user', [text('Make it faster')]),
    message('assistant', [text('Done.')]),
  ])
  expect(container.querySelectorAll('[data-role="user"] .message-bubble')).toHaveLength(1)
  expect(container.querySelectorAll('[data-role="assistant"] .message-bubble')).toHaveLength(0)
  expect(screen.queryByText('You')).toBeNull()
  expect(screen.queryByText('Ari')).toBeNull()
})

it('marks the time only where the conversation paused', () => {
  const start = new Date(2026, 9, 5, 9, 0).getTime()
  const { container } = show([
    message('user', [text('First')], start),
    message('assistant', [text('Reply')], start + 60_000),
    message('user', [text('Later')], start + 45 * 60_000),
  ])
  expect(container.querySelectorAll('time')).toHaveLength(2)
})

it('copies a code block from its own button', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const { container } = show([message('assistant', [text('```sh\npnpm verify\n```')])])
  const block = container.querySelector<HTMLElement>('.code-block')
  if (block === null) throw new Error('expected a code block')
  fireEvent.click(within(block).getByRole('button', { name: 'Copy' }))
  expect(writeText).toHaveBeenCalledWith('pnpm verify\n')
  expect(await within(block).findByRole('button', { name: 'Copied' })).toBeTruthy()
})

it('offers to copy a reply that has words, and not one that is only steps', () => {
  show([
    message('assistant', [text('Here is the answer.')]),
    message('assistant', [call('1', 'Read', { path: 'a.ts' })]),
  ])
  expect(screen.getAllByRole('button', { name: 'Copy reply' })).toHaveLength(1)
})

it('labels a message Ari or another session sent so it is not read as typed here', () => {
  show([
    { ...message('user', [text('Use SettingsStore.')]), origin: { kind: 'session', sessionId: 'p' } },
    {
      ...message('user', [text('Child session "Parser" finished its turn.')]),
      origin: { kind: 'completion', sessionIds: ['c'] },
    },
  ])
  expect(screen.getByText('From a linked session')).toBeTruthy()
  expect(screen.getByText('Delegation update from Ari')).toBeTruthy()
})
