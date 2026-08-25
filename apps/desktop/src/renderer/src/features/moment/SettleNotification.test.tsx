import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import {
  currentVisibility,
  installVisibilityGuard,
  notifyNeedsAttention,
  notifySettled,
  useSettleNotify,
} from './SettleNotification'

const PROTOTYPE_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'visibilityState',
)

function stubVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

function restoreVisibility(): void {
  if (PROTOTYPE_DESCRIPTOR) {
    Object.defineProperty(Document.prototype, 'visibilityState', PROTOTYPE_DESCRIPTOR)
  } else {
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState
  }
}

afterEach(() => {
  restoreVisibility()
})

describe('notifySettled', () => {
  it('no-ops while the window is visible', () => {
    stubVisibility('visible')
    const toast = vi.fn()

    const fired = notifySettled('Docs review', { toast })

    expect(fired).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })

  it('fires the toast only while hidden', () => {
    stubVisibility('hidden')
    const toast = vi.fn()

    const fired = notifySettled('Docs review', { toast })

    expect(fired).toBe(true)
    expect(toast).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith({
      title: 'Docs review',
      description: 'Turn complete.',
      tone: 'info',
    })
  })

  it('fires error toasts only while hidden — a focused window already shows the inline alert', () => {
    stubVisibility('visible')
    const toast = vi.fn()

    const fired = notifySettled('Docs review', { toast, error: 'spawn EINVAL' })

    expect(fired).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })

  it('still toasts failures while hidden, with class-name noise stripped', () => {
    stubVisibility('hidden')
    const toast = vi.fn()

    const fired = notifySettled('Docs review', { toast, error: 'AcpConnectionError: Authentication required' })

    expect(fired).toBe(true)
    expect(toast).toHaveBeenCalledOnce()
    expect(toast).toHaveBeenCalledWith({
      title: 'Docs review',
      description: 'Turn failed — Authentication required',
      tone: 'danger',
      durationMs: 8000,
    })
  })

  it('flattens and truncates long error messages', () => {
    stubVisibility('hidden')
    const toast = vi.fn()
    const long = Array.from({ length: 60 }, () => 'word \n').join('')

    notifySettled('Docs review', { toast, error: long })

    const call = toast.mock.calls[0]?.[0] as { description: string }
    expect(call.description.length).toBeLessThanOrEqual(240)
    expect(call.description).not.toContain('\n')
  })
})

describe('installVisibilityGuard', () => {
  it('mirrors visibility into module state and detaches on cleanup', () => {
    stubVisibility('hidden')
    const dispose = installVisibilityGuard()
    expect(currentVisibility()).toBe('hidden')

    stubVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(currentVisibility()).toBe('visible')

    dispose()
    stubVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(currentVisibility()).toBe('visible')
  })

  it('normalizes back to visible when the window regains focus', () => {
    stubVisibility('visible')
    const dispose = installVisibilityGuard()
    stubVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(currentVisibility()).toBe('hidden')

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(currentVisibility()).toBe('visible')
    dispose()
  })
})

describe('useSettleNotify', () => {
  interface Capture {
    notify?: () => void
  }

  function Probe({ capture }: { capture: Capture }) {
    capture.notify = useSettleNotify(() => 'Docs review')
    return null
  }

  it('routes settled sessions through the ToastProvider while hidden', async () => {
    stubVisibility('hidden')
    const capture: Capture = {}
    render(
      <ToastProvider>
        <Probe capture={capture} />
      </ToastProvider>,
    )

    await act(async () => {
      capture.notify?.()
    })

    expect(await screen.findByText('Turn complete.')).toBeInTheDocument()
    expect(screen.getByText('Docs review')).toBeInTheDocument()
  })

  it('emits nothing while visible', async () => {
    stubVisibility('visible')
    const capture: Capture = {}
    render(
      <ToastProvider>
        <Probe capture={capture} />
      </ToastProvider>,
    )

    await act(async () => {
      capture.notify?.()
    })

    await act(async () => {})
    expect(screen.queryByText('Turn complete.')).not.toBeInTheDocument()
  })
})

describe('notifyNeedsAttention', () => {
  it('stays silent while the window is visible', () => {
    stubVisibility('visible')
    const toast = vi.fn()

    expect(notifyNeedsAttention('Refactor', { toast, detail: 'bash approval' })).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })

  it('fires a warning toast with the blocking detail while hidden', () => {
    stubVisibility('hidden')
    const toast = vi.fn()

    const fired = notifyNeedsAttention('Refactor', { toast, detail: 'bash approval' })

    expect(fired).toBe(true)
    expect(toast).toHaveBeenCalledWith({
      title: 'Refactor',
      description: 'Waiting for you — bash approval',
      tone: 'warning',
    })
  })

  it('falls back to a generic description without detail', () => {
    stubVisibility('hidden')
    const toast = vi.fn()

    notifyNeedsAttention('Refactor', { toast })

    expect(toast).toHaveBeenCalledWith({
      title: 'Refactor',
      description: 'Waiting for your approval.',
      tone: 'warning',
    })
  })
})
