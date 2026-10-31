import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { OnboardingGate, type OnboardingWorkspaceProps } from './OnboardingGate'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
vi.mock('./OnboardingWizard', () => ({
  OnboardingWizard: ({ returning, onLeave }: { returning: boolean; onLeave: () => void }) => (
    <div>
      <h2>{returning ? 'Run setup again' : 'First setup'}</h2>
      <button onClick={onLeave}>Leave wizard</button>
    </div>
  ),
}))
function Workspace({ onOpenSetup }: OnboardingWorkspaceProps) {
  const [count, setCount] = useState(0)
  return (
    <main aria-label="Workspace">
      <button onClick={() => setCount(count + 1)}>Count {count}</button>
      <button onClick={onOpenSetup}>Open setup</button>
    </main>
  )
}
const mount = () => render(<OnboardingGate>{(props) => <Workspace {...props} />}</OnboardingGate>)
beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (method) =>
    method === 'settings.get' || method === 'settings.update' ? defaultSettings : [],
  )
})
afterEach(() => vi.useRealTimers())

describe('first-run gate', () => {
  it('waits for both lists and settings before deciding this is a new installation', async () => {
    let resolve!: (value: unknown[]) => void
    invoke.mockImplementation(async (method) => {
      if (method === 'settings.get') return defaultSettings
      if (method === 'session.list')
        return new Promise((done) => {
          resolve = done
        })
      return []
    })
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('Checking saved settings')
    expect(screen.queryByText('First setup')).not.toBeInTheDocument()
    await act(async () => {
      resolve([])
    })
    expect(screen.getByText('First setup')).toBeInTheDocument()
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
  })

  it('bypasses completed setup even with an empty workspace and a zero completion timestamp', async () => {
    invoke.mockImplementation(async (method) =>
      method === 'settings.get' ? { ...defaultSettings, onboarding: { completedAt: 0 } } : [],
    )
    mount()
    expect(await screen.findByRole('main', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.queryByText('First setup')).not.toBeInTheDocument()
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
  })

  it.each(['project.list', 'session.list'])(
    'migrates existing users when %s is non-empty, only once under StrictMode',
    async (existing) => {
      invoke.mockImplementation(async (method) => {
        if (method === 'settings.get' || method === 'settings.update') return defaultSettings
        return method === existing ? [{ id: 'existing' }] : []
      })
      render(
        <StrictMode>
          <OnboardingGate>{(props) => <Workspace {...props} />}</OnboardingGate>
        </StrictMode>,
      )
      await screen.findByRole('main', { name: 'Workspace' })
      expect(invoke.mock.calls.filter(([method]) => method === 'settings.update')).toHaveLength(1)
      expect(invoke).toHaveBeenCalledWith('settings.update', {
        onboarding: { completedAt: expect.any(Number) as unknown },
      })
    },
  )

  it.each(['settings.get', 'project.list', 'session.list'])(
    'does not classify a failed %s as first run and permits retry',
    async (failing) => {
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation((method, params) =>
        method === failing ? Promise.reject(new Error('unreadable')) : base(method, params),
      )
      mount()
      expect(await screen.findByRole('alert')).toHaveTextContent('could not read')
      expect(screen.queryByText('First setup')).not.toBeInTheDocument()
      expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
      invoke.mockImplementation(base)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('First setup')).toBeInTheDocument()
    },
  )

  it('never traps a hung boot request and ignores its late result after leaving', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace for now' }))
    await act(async () => {
      resolve(defaultSettings)
    })
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeInTheDocument()
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
    expect(screen.queryByText('First setup')).not.toBeInTheDocument()
  })

  it('does not block established users when their migration marker cannot be saved', async () => {
    invoke.mockImplementation(async (method) => {
      if (method === 'settings.get') return defaultSettings
      if (method === 'project.list') return [{ id: 'existing' }]
      if (method === 'settings.update') throw new Error('read only')
      return []
    })
    mount()
    expect(await screen.findByRole('main', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reopens setup without remounting the workspace or resetting its data', async () => {
    invoke.mockImplementation(async (method) =>
      method === 'settings.get' ? { ...defaultSettings, onboarding: { completedAt: 1 } } : [],
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Count 0' }))
    const trigger = screen.getByRole('button', { name: 'Open setup' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(await screen.findByText('Run setup again')).toBeInTheDocument()
    expect(screen.queryByRole('main', { name: 'Workspace' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Leave wizard' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Count 1' })).toBeVisible())
    expect(trigger).toHaveFocus()
    expect(
      invoke.mock.calls.every(([method]) =>
        ['settings.get', 'project.list', 'session.list'].includes(method),
      ),
    ).toBe(true)
  })
})
