// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

const app = vi.hoisted(() => ({
  origin: 'https://phone.test',
  session: { deviceId: 'phone', send: vi.fn<() => Promise<void>>(), supports: () => true },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))
beforeEach(() => {
  sessionStorage.clear()
  app.session.send.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const props = {
  sessionId: 'session',
  controls: null,
  disabled: false,
  onSent: async () => {},
  onError: vi.fn(),
}
it('shows sending immediately, working through the turn, and removes activity when settled', async () => {
  let accepted: (() => void) | undefined
  app.session.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accepted = resolve
      }),
  )
  const view = render(<Composer {...props} status="idle" />)
  expect(screen.queryByRole('status', { name: /^(Sending|Working)$/ })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), {
    target: { value: 'Build it' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(screen.getByRole('status', { name: 'Sending' }).textContent).toBe(
    'Sending to your computer…',
  )
  await act(async () => {
    accepted?.()
  })
  view.rerender(<Composer {...props} status="running" />)
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toBe('Working…')
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  view.rerender(<Composer {...props} status="waiting-approval" />)
  expect(screen.queryByRole('status', { name: /^(Sending|Working)$/ })).toBeNull()
  view.rerender(<Composer {...props} status="idle" />)
  expect(screen.queryByRole('status', { name: /^(Sending|Working)$/ })).toBeNull()
})
it('moves a message into the conversation at once and confirms it when accepted', async () => {
  let accepted: (() => void) | undefined
  app.session.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accepted = resolve
      }),
  )
  const onOutbox = vi.fn()
  render(<Composer {...props} status="idle" onOutbox={onOutbox} />)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message the agent' })
  fireEvent.change(field, { target: { value: 'Build it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  // Before any answer: the words left the field and wait in the conversation.
  expect(field.value).toBe('')
  expect(onOutbox).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: 'Build it', mode: 'send', state: 'sending' }),
  )
  // The next message can be typed while this one travels.
  expect(field.disabled).toBe(false)
  await act(async () => {
    accepted?.()
  })
  expect(onOutbox).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'accepted' }))
  expect(sessionStorage.length).toBe(0)
})
it('hands a refused message back to the field, and marks a lost answer as unconfirmed', async () => {
  const { RemoteError } = await import('../../lib/gateway-client')
  const onOutbox = vi.fn()
  app.session.send.mockRejectedValueOnce(new RemoteError('access_revoked', 'Refused'))
  const view = render(<Composer {...props} status="idle" onOutbox={onOutbox} />)
  const field = (): HTMLTextAreaElement =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message the agent' })
  fireEvent.change(field(), { target: { value: 'Try this' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  })
  expect(onOutbox).toHaveBeenLastCalledWith(null)
  expect(field().value).toBe('Try this')
  view.unmount()

  app.session.send.mockRejectedValueOnce(new RemoteError('unreachable', 'Lost'))
  render(<Composer {...props} status="idle" onOutbox={onOutbox} />)
  fireEvent.change(field(), { target: { value: 'Maybe sent' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  })
  expect(onOutbox).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: 'Maybe sent', state: 'uncertain' }),
  )
  // Only its receipt can settle it; it is never sent again by itself.
  expect(screen.getByRole('button', { name: 'Check submission receipt' })).toBeTruthy()
  expect(app.session.send).toHaveBeenCalledTimes(2)
})
it('shows working for a turn started on desktop and suppresses stale activity offline', () => {
  const view = render(<Composer {...props} status="running" />)
  expect(screen.getByRole('status').textContent).toBe('Working…')
  expect(view.container.querySelectorAll('.mobile-working-cell')).toHaveLength(8)
  view.rerender(<Composer {...props} status="running" disabled />)
  expect(screen.queryByRole('status')).toBeNull()
})
it('shows how long the agent has been working when it knows when the turn began', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(100_000)
    render(<Composer {...props} status="running" workingSince={100_000 - 65_000} />)
    expect(screen.getByRole('status', { name: 'Working' }).textContent).toBe('Working…1:05')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByRole('status', { name: 'Working' }).textContent).toBe('Working…1:07')
  } finally {
    vi.useRealTimers()
  }
})
