import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider } from '@ari/ui/toast'
import { MotionProvider } from '@ari/ui/motion-provider'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomePanel } from './WelcomePanel'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

/** The panel toasts on connect and animates in, so it needs both providers. */
function renderPanel(hasProjects: boolean, strict = false) {
  const onCreateSession = vi.fn()
  const panel = (
    <ToastProvider>
      <MotionProvider>
        <WelcomePanel
          hasProjects={hasProjects}
          onCreateSession={onCreateSession}
          onConnect={() => {}}
        />
      </MotionProvider>
    </ToastProvider>
  )
  return { ...render(strict ? <StrictMode>{panel}</StrictMode> : panel), onCreateSession }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const installedAgent = {
  kind: 'claude',
  binaryPath: '/bin/claude',
  version: '2.1.0',
  authStatus: 'authenticated',
}

describe('WelcomePanel', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  beforeEach(() => {
    rpcMocks.invoke.mockReset()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect' || method === 'providers.rescan') return []
      if (method === 'endpoints.list') return []
      throw new Error(`unexpected method: ${method}`)
    })
  })

  it('says what to do first when no project is registered', async () => {
    renderPanel(false)

    expect(
      await screen.findByRole('button', { name: 'Add a project to start' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Connect a model to begin')).toBeInTheDocument()
  })

  it('offers to start a session once a project exists', async () => {
    const { onCreateSession } = renderPanel(true)

    const start = await screen.findByRole('button', { name: 'Start a new session' })
    fireEvent.click(start)
    expect(onCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    )
    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument()
    expect(await screen.findByText('Connect a model to begin')).toBeInTheDocument()
  })

  it('shows loading and waits for both successful checks before offering setup', async () => {
    const providers = deferred<[]>()
    const endpoints = deferred<[]>()
    rpcMocks.invoke.mockImplementation((method: string) =>
      method === 'providers.detect' ? providers.promise : endpoints.promise,
    )
    renderPanel(false)

    expect(screen.getByRole('status')).toHaveTextContent('Checking local agents')
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    await act(async () => {
      providers.resolve([])
    })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    await act(async () => {
      endpoints.resolve([])
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('Connect a model to begin')).toBeInTheDocument()
  })

  it.each([
    ['providers.detect', 'local agents'],
    ['endpoints.list', 'saved model endpoints'],
  ])('does not interpret a failed %s as empty setup', async (failedMethod, label) => {
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === failedMethod) throw new Error('Unavailable')
      return []
    })
    renderPanel(true)

    expect(await screen.findByRole('alert')).toHaveTextContent(`Could not check ${label}`)
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry setup checks' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a new session' })).toBeEnabled()
  })

  it.each(['providers.detect', 'endpoints.list'])(
    'retries only the failed %s check',
    async (failedMethod) => {
      rpcMocks.invoke.mockImplementation(async (method: string) => {
        if (method === failedMethod) throw new Error('Unavailable')
        return []
      })
      renderPanel(true)
      await screen.findByRole('alert')
      rpcMocks.invoke.mockImplementation(async () => [])

      fireEvent.click(screen.getByRole('button', { name: 'Retry setup checks' }))
      expect(await screen.findByText('Connect a model to begin')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      const methods = rpcMocks.invoke.mock.calls.map(([method]) => method as string)
      expect(methods).toEqual([
        'providers.detect',
        'endpoints.list',
        failedMethod === 'providers.detect' ? 'providers.rescan' : 'endpoints.list',
      ])
    },
  )

  it('retains successful agents across repeated endpoint failures and retries', async () => {
    rpcMocks.invoke.mockRejectedValue(new Error('Unavailable'))
    renderPanel(true)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'local agents and saved model endpoints',
    )
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'endpoints.list') throw new Error('Still unavailable')
      return [installedAgent]
    })

    fireEvent.click(screen.getByRole('button', { name: 'Retry setup checks' }))
    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not check saved model endpoints')
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    const endpoints = deferred<[]>()
    rpcMocks.invoke.mockReturnValue(endpoints.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup checks' }))
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    await act(async () => {
      endpoints.resolve([])
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    expect(
      rpcMocks.invoke.mock.calls.filter(([method]) => method === 'providers.rescan'),
    ).toHaveLength(1)
  })

  it.each(['agent', 'endpoint'])(
    'does not offer setup when an %s is already available',
    async (available) => {
      rpcMocks.invoke.mockImplementation(async (method: string) => {
        if (method === 'providers.detect' && available === 'agent') return [installedAgent]
        if (method === 'endpoints.list' && available === 'endpoint') return [{ id: 'saved' }]
        return []
      })
      renderPanel(true)
      await act(async () => {})
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()
    },
  )

  it('makes a hung check retryable and ignores its late result after recovery', async () => {
    vi.useFakeTimers()
    const stalled = deferred<{ id: string }[]>()
    rpcMocks.invoke.mockImplementation(async (method: string) =>
      method === 'endpoints.list' ? stalled.promise : [],
    )
    renderPanel(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not check saved model endpoints')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText('Connect a model to begin')).not.toBeInTheDocument()

    rpcMocks.invoke.mockResolvedValue([])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry setup checks' }))
    })
    expect(screen.getByText('Connect a model to begin')).toBeInTheDocument()
    await act(async () => {
      stalled.resolve([{ id: 'stale' }])
    })
    expect(screen.getByText('Connect a model to begin')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores checks from the effect cleaned up by StrictMode', async () => {
    const stale = deferred<(typeof installedAgent)[]>()
    let providerCalls = 0
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect' && ++providerCalls === 1) return stale.promise
      return []
    })
    renderPanel(true, true)
    expect(await screen.findByText('Connect a model to begin')).toBeInTheDocument()

    await act(async () => {
      stale.resolve([installedAgent])
    })
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
    expect(screen.getByText('Connect a model to begin')).toBeInTheDocument()
  })
})
