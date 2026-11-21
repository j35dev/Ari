import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { OnboardingWizard } from './OnboardingWizard'

const { invoke, setMode } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  setMode: vi.fn(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke, subscribe: () => () => undefined } }))
// The frame's scene art reads the theme and paints a canvas; neither is under test here.
vi.mock('../scene/DitherScene', () => ({ DitherScene: () => null }))
vi.mock('@ari/ui/theme-provider', () => ({ useTheme: () => ({ mode: 'system', setMode }) }))

const onFinished = vi.fn()
const onLeave = vi.fn()
const mount = (returning = false, reduced = false) =>
  render(
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <OnboardingWizard
        settings={defaultSettings}
        returning={returning}
        onFinished={onFinished}
        onLeave={onLeave}
      />
    </MotionConfig>,
  )
const key = (name: 'Enter' | 'Escape') =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: name })

/** Welcome → agent → projects → look, ending on the theme step. */
async function walk() {
  await screen.findByText('Found Claude Code')
  fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
  await screen.findByRole('radio', { name: 'Claude Code', checked: true })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Add 1 project' }))
  await screen.findByRole('heading', { name: 'Make it yours' })
}

afterEach(cleanup)
beforeEach(() => {
  onFinished.mockReset()
  onLeave.mockReset()
  setMode.mockReset()
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'settings.get' || method === 'settings.update') return defaultSettings
    if (method === 'providers.detect' || method === 'providers.rescan')
      return [
        {
          kind: 'claude',
          installed: true,
          binaryPath: '/bin/claude',
          version: '2.1.0',
          authStatus: 'authenticated',
        },
      ]
    if (method === 'project.discover')
      return {
        projects: [
          { path: '/work/ari', name: 'Ari', sources: ['claude'], lastUsedAt: 1, branch: 'main' },
        ],
        truncated: false,
        warnings: [],
      }
    if (method === 'project.open') return { id: (params as { path: string }).path, status: 'ok' }
    throw new Error(method)
  })
})

describe('onboarding wizard', () => {
  it('detects at once, then walks every step with focus on each heading', async () => {
    mount()
    expect(screen.getByRole('heading', { name: 'Welcome to Ari' })).toHaveFocus()
    expect(invoke).toHaveBeenCalledWith('providers.detect')
    await walk()
    expect(screen.getByRole('heading', { name: 'Make it yours' })).toHaveFocus()
    // Nothing is imported or saved before the last step.
    expect(invoke.mock.calls.some(([method]) => method === 'project.open')).toBe(false)
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Light (Porcelain)' }))
    expect(setMode).toHaveBeenCalledWith('porcelain')
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    const checklist = await screen.findByRole('list', { name: 'What was set up' })
    expect(within(checklist).getByText('Claude Code is ready')).toBeInTheDocument()
    expect(within(checklist).getByText('1 project added')).toBeInTheDocument()
    // Saving starts with the checklist; the zoom into the workspace follows it.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'settings.update',
        expect.objectContaining({ sessions: { defaultDriverKind: 'claude' } }),
      ),
    )
    expect(invoke).toHaveBeenCalledWith('project.open', { path: '/work/ari' })
    await waitFor(
      () =>
        expect(onFinished).toHaveBeenCalledWith(
          { sessionId: null, projectId: '/work/ari', driverKind: 'claude' },
          { animate: true },
        ),
      { timeout: 4000 },
    )
  })

  it('continues on Enter and goes back on Esc', async () => {
    mount()
    await screen.findByText('Found Claude Code')
    key('Enter')
    expect(await screen.findByRole('heading', { name: 'Choose your agent' })).toHaveFocus()
    await screen.findByRole('radio', { name: 'Claude Code', checked: true })
    key('Enter')
    expect(await screen.findByRole('heading', { name: 'Open your projects' })).toHaveFocus()
    key('Escape')
    expect(await screen.findByRole('heading', { name: 'Choose your agent' })).toHaveFocus()
    key('Escape')
    expect(await screen.findByRole('heading', { name: 'Welcome to Ari' })).toHaveFocus()
  })

  it('does not take Enter from a text field', async () => {
    mount()
    await screen.findByText('Found Claude Code')
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add another agent/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Use an API key or a local model/ }))
    const field = await screen.findByLabelText('OpenRouter API key')
    field.focus()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(
      screen.getByRole('heading', { name: 'Use an API key or a local model' }),
    ).toBeInTheDocument()
  })

  it('lands plainly under reduced motion, without waiting for the checklist', async () => {
    mount(false, true)
    await walk()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        { sessionId: null, projectId: '/work/ari', driverKind: 'claude' },
        { animate: false },
      ),
    )
  })

  it('skips without opening folders or changing the saved default', async () => {
    mount()
    await screen.findByText('Found Claude Code')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        { sessionId: null, projectId: null, driverKind: null },
        { animate: false },
      ),
    )
    expect(invoke.mock.calls.some(([method]) => method === 'project.open')).toBe(false)
    expect(invoke).toHaveBeenCalledWith(
      'settings.update',
      expect.not.objectContaining({ sessions: expect.anything() as unknown }),
    )
  })

  it('retries a failed save in place without leaving early', async () => {
    const base = invoke.getMockImplementation()!
    let failed = false
    invoke.mockImplementation((method, params) => {
      if (method === 'settings.update' && !failed) {
        failed = true
        return Promise.reject(new Error('full disk'))
      }
      return base(method, params)
    })
    mount(false, true)
    await walk()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('completion could not be saved')
    expect(onFinished).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onFinished).toHaveBeenCalledOnce())
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(1)
  })

  it('lets the user keep the rest of setup without a folder that failed', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'project.open' ? Promise.reject(new Error('missing')) : base(method, params),
    )
    mount(false, true)
    await walk()
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue without these folders' }))
    await waitFor(() =>
      expect(onFinished).toHaveBeenCalledWith(
        { sessionId: null, projectId: null, driverKind: 'claude' },
        { animate: false },
      ),
    )
  })

  it('re-entry leaves without resetting anything', async () => {
    mount(true)
    await screen.findByText('Found Claude Code')
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(onLeave).toHaveBeenCalledOnce()
    expect(
      invoke.mock.calls.some(
        ([method]) => method === 'settings.update' || method === 'project.open',
      ),
    ).toBe(false)
  })

  it('does not continue mutations after the wizard unmounts', async () => {
    const { unmount } = mount()
    await walk()
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }))
    unmount()
    await act(async () => {
      resolve({ id: 'ari', status: 'ok' })
    })
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(1)
    expect(invoke.mock.calls.some(([method]) => method === 'settings.update')).toBe(false)
    expect(onFinished).not.toHaveBeenCalled()
  })
})
