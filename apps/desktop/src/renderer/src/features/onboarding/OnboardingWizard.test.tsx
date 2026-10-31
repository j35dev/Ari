import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { OnboardingWizard } from './OnboardingWizard'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
vi.mock('./OnboardingAgents', () => ({
  OnboardingAgents: ({
    onSelect,
    onBusyChange,
  }: {
    onSelect: (kind: string) => void
    onBusyChange: (busy: boolean) => void
  }) => (
    <>
      <button onClick={() => onSelect('claude')}>Choose Claude</button>
      <button onClick={() => onBusyChange(true)}>Begin sign-in</button>
      <button onClick={() => onBusyChange(false)}>Close sign-in</button>
    </>
  ),
}))
vi.mock('./OnboardingProjects', () => ({
  OnboardingProjects: ({ onChange }: { onChange: (projects: unknown[]) => void }) => (
    <button
      onClick={() =>
        onChange([
          { path: '/work/ari', name: 'Ari', sources: [], lastUsedAt: null },
          { path: '/work/docs', name: 'Docs', sources: [], lastUsedAt: null },
        ])
      }
    >
      Choose folders
    </button>
  ),
}))
const onFinished = vi.fn()
const onLeave = vi.fn()
const mount = (returning = false) =>
  render(
    <OnboardingWizard
      settings={defaultSettings}
      returning={returning}
      onFinished={onFinished}
      onLeave={onLeave}
    />,
  )
const review = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Choose Claude' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose folders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}
beforeEach(() => {
  onFinished.mockReset()
  onLeave.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'settings.get' || method === 'settings.update') return defaultSettings
    if (method === 'project.open') return { id: (params as { path: string }).path, status: 'ok' }
    if (method === 'session.create') return { sessionId: 'first' }
    throw new Error(method)
  })
})

describe('onboarding wizard', () => {
  it('reviews choices before doing any import and focuses each step heading', async () => {
    mount()
    review()
    expect(screen.getByRole('heading', { name: 'Ready when you are.' })).toHaveFocus()
    expect(screen.getByText('/work/ari')).toBeInTheDocument()
    expect(invoke.mock.calls.every(([method]) => method === 'settings.get')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith({ sessionId: 'first', driverKind: 'claude' }),
    )
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
  })
  it('skips without opening selected folders or changing the saved default', async () => {
    mount()
    review()
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith({ sessionId: null, driverKind: null }),
    )
    expect(
      invoke.mock.calls.some(
        ([method]) => method === 'project.open' || method === 'session.create',
      ),
    ).toBe(false)
    expect(invoke).toHaveBeenCalledWith(
      'settings.update',
      expect.not.objectContaining({ sessions: expect.anything() as unknown }),
    )
  })
  it('keeps navigation and exit disabled while native sign-in is open', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Begin sign-in' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Your projects' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close sign-in' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })
  it('retries failed saves without duplicating a session or dismissing the error early', async () => {
    const base = invoke.getMockImplementation()!
    let failed = false
    invoke.mockImplementation((method, params) => {
      if (method === 'settings.update' && !failed) {
        failed = true
        return Promise.reject(new Error('full disk'))
      }
      return base(method, params)
    })
    mount()
    review()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('completion could not be saved')
    expect(onFinished).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Your agents' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce())
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
  })
  it('lets the user keep successful imports and omit unavailable folders', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'project.open' && (params as { path: string }).path === '/work/docs'
        ? Promise.reject(new Error('missing'))
        : base(method, params),
    )
    mount()
    review()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without these folders' }))
    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce())
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(2)
  })
  it('offers a no-session exit after creation fails', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'session.create' ? Promise.reject(new Error('failed')) : base(method, params),
    )
    mount()
    review()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without a session' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith({ sessionId: null, driverKind: 'claude' }),
    )
  })
  it('re-entry defaults to no new session and can leave without resetting data', () => {
    mount(true)
    review()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(onLeave).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.every(([method]) => method === 'settings.get')).toBe(true)
  })
  it('does not continue mutations after the wizard unmounts', async () => {
    const { unmount } = mount()
    review()
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    unmount()
    await act(async () => {
      resolve({ id: 'ari', status: 'ok' })
    })
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(1)
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
    expect(onFinished).not.toHaveBeenCalled()
  })
})
