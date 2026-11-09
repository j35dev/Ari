import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { registerOverlay } from '@ari/ui/overlay-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureSessionStartIntent, type SessionStartScope } from './session-start-focus'

afterEach(cleanup)

function setup() {
  render(
    <>
      <button>Start</button>
      <button>Elsewhere</button>
      <textarea aria-label="Message" />
    </>,
  )
  const origin = screen.getByRole('button', { name: 'Start' })
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
  origin.focus()
  let current: SessionStartScope = { spaceId: 'space', paneId: 'pane', sessionId: null }
  const onDispose = vi.fn()
  const intent = captureSessionStartIntent(
    () => current,
    () => true,
    onDispose,
  )
  expect(intent.select('session')).toBe(true)
  current = { ...current, sessionId: 'session' }
  return {
    input,
    intent,
    onDispose,
    changeScope: (next: SessionStartScope) => {
      current = next
    },
  }
}

describe('session-start focus ownership', () => {
  it('allows a start launched while its workspace tool is closing', async () => {
    render(
      <>
        <button>Start</button>
        <textarea aria-label="Message" />
      </>,
    )
    screen.getByRole('button', { name: 'Start' }).focus()
    let current = { spaceId: 'space', paneId: 'pane', sessionId: null as string | null }
    let visible = false
    const intent = captureSessionStartIntent(
      () => current,
      () => visible,
      () => {},
    )
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
    try {
      expect(intent.isCurrent()).toBe(true)
      expect(intent.select('session')).toBe(true)
      current = { ...current, sessionId: 'session' }
      visible = true
      intent.ready(input)
      await vi.waitFor(() => expect(input).toHaveFocus())
    } finally {
      intent.dispose()
    }
  })

  it('waits for its launching dialog to exit, then focuses only once', async () => {
    render(
      <>
        <div data-launcher>
          <div role="dialog" aria-label="New session">
            <input aria-label="Search projects" />
          </div>
        </div>
        <textarea aria-label="Message" />
      </>,
    )
    screen.getByRole('textbox', { name: 'Search projects' }).focus()
    const overlay = screen.getByRole('dialog').parentElement!
    const release = registerOverlay(overlay)
    const current = { spaceId: 'space', paneId: 'pane', sessionId: 'session' }
    const intent = captureSessionStartIntent(
      () => current,
      () => true,
      () => {},
    )
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' })
    const focus = vi.spyOn(input, 'focus')
    try {
      expect(intent.select('session')).toBe(true)
      intent.ready(input)
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      expect(input).not.toHaveFocus()
      release()
      await vi.waitFor(() => expect(input).toHaveFocus())
      intent.ready(input)
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      release()
      intent.dispose()
    }
  })

  it('does not treat an unrelated open dialog as a launching menu', () => {
    render(
      <>
        <div role="dialog" aria-label="Settings">
          <input aria-label="Setting" />
        </div>
        <textarea aria-label="Message" />
      </>,
    )
    const dialog = screen.getByRole('dialog')
    const release = registerOverlay(dialog)
    screen.getByRole('textbox', { name: 'Setting' }).focus()
    const intent = captureSessionStartIntent(
      () => ({ spaceId: 'space', paneId: 'pane', sessionId: null }),
      () => true,
      () => {},
    )
    try {
      expect(intent.select('session')).toBe(false)
    } finally {
      release()
      intent.dispose()
    }
  })

  it.each(['hidden', 'inert', 'disabled', 'detached'] as const)(
    'does not focus an editor that became %s before the frame',
    async (condition) => {
      const { input, intent, onDispose } = setup()
      const parent = input.parentElement!
      try {
        intent.ready(input)
        if (condition === 'disabled') input.disabled = true
        else if (condition === 'detached') input.remove()
        else input.setAttribute(condition, '')
        await vi.waitFor(() => expect(onDispose).toHaveBeenCalledOnce())
        expect(input).not.toHaveFocus()
      } finally {
        intent.dispose()
        if (!input.isConnected) parent.append(input)
      }
    },
  )

  it('rechecks the pane immediately before applying focus', async () => {
    const { input, intent, changeScope, onDispose } = setup()
    intent.ready(input)
    changeScope({ spaceId: 'space', paneId: 'other-pane', sessionId: 'session' })
    await vi.waitFor(() => expect(onDispose).toHaveBeenCalledOnce())
    expect(input).not.toHaveFocus()
  })

  it('abandons a scheduled focus when the user acts elsewhere', async () => {
    const { input, intent, onDispose } = setup()
    intent.ready(input)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    await vi.waitFor(() => expect(onDispose).toHaveBeenCalledOnce())
    expect(input).not.toHaveFocus()
  })
})
