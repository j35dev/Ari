import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './Toast'
import type { ToastOptions } from './Toast'

function Probe({ opts }: { opts: ToastOptions }) {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast(opts)}>
      show
    </button>
  )
}

afterEach(() => {
  cleanup()
})

describe('Toast', () => {
  it('renders title via useToast().toast() with status role and polite live region', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Saved', description: 'All changes written' }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByText('All changes written')).toBeInTheDocument()
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveClass(
      'bg-surface-2',
      'border',
      'border-border',
      'rounded-lg',
      'shadow-2',
      'p-3',
      'w-80',
      'border-l-4',
    )
  })

  it('maps tones to accent bar token colors on the toast card', async () => {
    const user = userEvent.setup()
    const tones: ToastOptions[] = [
      { title: 'neutral' },
      { title: 'success', tone: 'success' },
      { title: 'warning', tone: 'warning' },
      { title: 'danger', tone: 'danger' },
      { title: 'info', tone: 'info' },
    ]
    function ToneProbe() {
      const { toast } = useToast()
      return (
        <button type="button" onClick={() => tones.forEach((t) => toast(t))}>
          show all
        </button>
      )
    }
    render(
      <ToastProvider>
        <ToneProbe />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show all' }))
    const expected: Record<string, string> = {
      neutral: 'border-l-accent-subtle',
      success: 'border-l-success',
      warning: 'border-l-warning',
      danger: 'border-l-danger',
      info: 'border-l-info',
    }
    for (const [title, cls] of Object.entries(expected)) {
      const card = screen.getByText(title).closest('[role="status"]')
      expect(card).not.toBeNull()
      expect(card).toHaveClass(cls)
    }
  })

  it('auto-dismisses after durationMs', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Transient', durationMs: 120 }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    expect(screen.getByText('Transient')).toBeInTheDocument()
    await waitFor(
      () => expect(screen.queryByText('Transient')).not.toBeInTheDocument(),
      { timeout: 1500 },
    )
  }, 3000)

  it('pauses dismissal while hovered and resumes on leave', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Paused', durationMs: 200 }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    await user.hover(screen.getByRole('status'))
    // Well past the original duration — hovered toasts must survive.
    await new Promise((r) => setTimeout(r, 350))
    expect(screen.getByText('Paused')).toBeInTheDocument()
    await user.unhover(screen.getByRole('status'))
    await waitFor(
      () => expect(screen.queryByText('Paused')).not.toBeInTheDocument(),
      { timeout: 1500 },
    )
  }, 4000)

  it('fires action onClick then dismisses', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'File deleted', action: { label: 'Undo', onClick } }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onClick).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByText('File deleted')).not.toBeInTheDocument())
  })

  it('dismisses via the Dismiss button', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Sticky' }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('Sticky')).not.toBeInTheDocument())
  })

  it('caps the viewport at 5 toasts, dropping the oldest', async () => {
    const user = userEvent.setup()
    function CountingProbe() {
      const countRef = useRef(0)
      const { toast } = useToast()
      return (
        <button
          type="button"
          onClick={() => {
            countRef.current += 1
            toast({ title: `T${countRef.current}`, durationMs: 60_000 })
          }}
        >
          show
        </button>
      )
    }
    render(
      <ToastProvider>
        <CountingProbe />
      </ToastProvider>,
    )
    for (let i = 1; i <= 6; i++) {
      await user.click(screen.getByRole('button', { name: 'show' }))
    }
    // The dropped toast leaves the DOM only after its exit animation.
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(5))
    expect(screen.queryByText('T1')).not.toBeInTheDocument()
    for (let i = 2; i <= 6; i++) {
      expect(screen.getByText(`T${i}`)).toBeInTheDocument()
    }
  })

  it('anchors the viewport at the top right below the titlebar', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Placed' }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    const viewport = document.querySelector('[data-toast-viewport]')
    expect(viewport).not.toBeNull()
    expect(viewport).toHaveClass('fixed', 'top-12', 'right-4')
    expect(viewport).not.toHaveClass('bottom-4')
  })

  it('keeps a durationMs of 0 until dismissed', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Probe opts={{ title: 'Sticky', durationMs: 0 }} />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    await new Promise((r) => setTimeout(r, 250))
    expect(screen.getByText('Sticky')).toBeInTheDocument()
  })

  it('update() mutates an existing toast in place', async () => {
    function UpdateProbe() {
      const { toast, update } = useToast()
      return (
        <button
          type="button"
          onClick={() => {
            const id = toast({ title: 'Updating…', durationMs: 0 })
            update(id, { title: 'Up to date', tone: 'success', durationMs: 60_000 })
          }}
        >
          show
        </button>
      )
    }
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <UpdateProbe />
      </ToastProvider>,
    )
    await user.click(screen.getByRole('button', { name: 'show' }))
    expect(await screen.findByText('Up to date')).toBeInTheDocument()
    expect(screen.queryByText('Updating…')).not.toBeInTheDocument()
  })
})
