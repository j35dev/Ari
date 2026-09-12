import { render, screen } from '@testing-library/react'
import { ToastProvider } from '@ari/ui/toast'
import { MotionProvider } from '@ari/ui/motion-provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WelcomePanel } from './WelcomePanel'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

/** The panel toasts on connect and animates in, so it needs both providers. */
function renderPanel(hasProjects: boolean) {
  return render(
    <ToastProvider>
      <MotionProvider>
        <WelcomePanel hasProjects={hasProjects} onCreateSession={() => {}} onConnect={() => {}} />
      </MotionProvider>
    </ToastProvider>,
  )
}

describe('WelcomePanel', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return []
      if (method === 'endpoints.list') return []
      throw new Error(`unexpected method: ${method}`)
    })
  })

  it('says what to do first when no project is registered', async () => {
    renderPanel(false)

    expect(
      await screen.findByRole('button', { name: 'Add a project to start' }),
    ).toBeInTheDocument()
  })

  it('offers to start a session once a project exists', async () => {
    renderPanel(true)

    expect(await screen.findByRole('button', { name: 'Start a new session' })).toBeInTheDocument()
  })
})
