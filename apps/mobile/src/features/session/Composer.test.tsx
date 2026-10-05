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
it('shows working for a turn started on desktop and suppresses stale activity offline', () => {
  const view = render(<Composer {...props} status="running" />)
  expect(screen.getByRole('status').textContent).toBe('Working…')
  expect(view.container.querySelectorAll('.mobile-working-cell')).toHaveLength(8)
  view.rerender(<Composer {...props} status="running" disabled />)
  expect(screen.queryByRole('status')).toBeNull()
})
