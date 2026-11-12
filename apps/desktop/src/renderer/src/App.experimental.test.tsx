import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { settingsSchema, type SettingsUpdate } from '@ari/contracts/settings'
import type { OnboardingWorkspaceProps } from './features/onboarding/OnboardingGate'
import { App } from './App'
import { useEngineSettings } from './features/settings/useEngineSettings'
import { splitLayoutActions, splitLayoutSnapshot } from './features/split/use-split-layout'
import { keepAliveActions } from './features/session/session-keep-alive'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('./lib/rpc', () => ({ rpc: mocks }))
vi.mock('./features/onboarding/OnboardingGate', () => ({
  OnboardingGate: ({ children }: { children: (props: OnboardingWorkspaceProps) => ReactNode }) =>
    children({ onOpenSetup: () => undefined, setupCovered: false, onboardingOutcome: null }),
}))
vi.mock('./features/focus', () => ({ FocusPill: () => null }))
vi.mock('./features/usage/ProviderUsagePill', () => ({ ProviderUsagePill: () => null }))
vi.mock('./features/session/SessionView', () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => (
    <div>{sessionId === 'aria' ? 'Saved coordinator history' : 'Ordinary project chat'}</div>
  ),
}))
let settings: ReturnType<typeof settingsSchema.parse>
const sessions = [
  { id: 'aria', projectId: 'helm', title: 'Aria', updatedAt: 2, messageCount: 42 },
  { id: 'ordinary', projectId: 'p', title: 'Project task', updatedAt: 1, messageCount: 3 },
]
function Toggle() {
  const { settings, update } = useEngineSettings()
  return (
    <button
      onClick={() =>
        void update({ experimental: { ariaEnabled: !settings?.experimental.ariaEnabled } })
      }
    >
      Toggle experiment
    </button>
  )
}
beforeEach(() => {
  localStorage.clear()
  splitLayoutActions.reset()
  keepAliveActions.reset()
  settings = settingsSchema.parse({
    version: 1,
    onboarding: { completedAt: 1 },
    speech: { shortcut: 'ctrl+f20' },
  })
  mocks.invoke.mockReset().mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsUpdate
        settings = settingsSchema.parse({
          ...settings,
          experimental: { ...settings.experimental, ...patch.experimental },
        })
        return settings
      }
      case 'session.list':
        return sessions
      case 'project.list':
        return [{ id: 'p', name: 'Project', path: '/p', status: 'ok', open: true }]
      case 'app.info':
        return { homeDir: '/home', platform: 'win32' }
      case 'session.workspace':
        return { path: '/p' }
      case 'providers.detect':
      case 'providers.models':
      case 'endpoints.list':
        return []
      case 'files.index':
        return { paths: [] }
      case 'aria.open':
        return { sessionId: 'aria' }
      default:
        return undefined
    }
  })
})
afterEach(cleanup)

it('hides Aria at startup and leaves its shortcut and palette action inactive', async () => {
  splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'aria')
  render(<App />)
  await screen.findByText('Project task')
  expect(screen.queryByRole('button', { name: 'Open Aria' })).not.toBeInTheDocument()
  expect(screen.queryByText('Saved coordinator history')).not.toBeInTheDocument()
  const key = new KeyboardEvent('keydown', {
    key: '0',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  window.dispatchEvent(key)
  expect(key.defaultPrevented).toBe(false)
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  expect(screen.queryByText('Open Aria')).not.toBeInTheDocument()
  expect(
    mocks.invoke.mock.calls.some(([method]) => method === 'aria.open' || method === 'aria.newChat'),
  ).toBe(false)
})

it('restores the saved chat when enabled and unmounts it again without changing saved data', async () => {
  render(
    <>
      <App />
      <Toggle />
    </>,
  )
  await screen.findByText('Project task')
  fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
  const open = await screen.findByRole('button', { name: 'Open Aria' })
  fireEvent.click(open)
  await screen.findByText('Saved coordinator history')
  expect(sessions[0]?.messageCount).toBe(42)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
  await waitFor(() =>
    expect(screen.queryByText('Saved coordinator history')).not.toBeInTheDocument(),
  )
  expect(screen.queryByRole('button', { name: 'Open Aria' })).not.toBeInTheDocument()
  expect(settings.speech.shortcut).toBe('ctrl+f20')
  expect(sessions[0]?.messageCount).toBe(42)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open Aria' }))
  await screen.findByText('Saved coordinator history')
  expect(
    mocks.invoke.mock.calls.some(
      ([method]) =>
        method === 'session.create' || method === 'aria.newChat' || method === 'session.destroy',
    ),
  ).toBe(false)
})

it('keeps ordinary chats available when settings fail to load', async () => {
  const invoke = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'settings.get') throw new Error('Settings unavailable')
    return invoke(method, params)
  })
  splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'ordinary')
  render(<App />)
  await screen.findByText('Ordinary project chat')
  expect(screen.queryByRole('button', { name: 'Open Aria' })).not.toBeInTheDocument()
})

it('unmounts a cached Aria chat when disabled while leaving the ordinary chat open', async () => {
  settings = settingsSchema.parse({ ...settings, experimental: { ariaEnabled: true } })
  render(
    <>
      <App />
      <Toggle />
    </>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Open Aria' }))
  await screen.findByText('Saved coordinator history')
  fireEvent.click(screen.getByText('Project task'))
  await screen.findByText('Ordinary project chat')
  expect(screen.getByText('Saved coordinator history')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
  await waitFor(() =>
    expect(screen.queryByText('Saved coordinator history')).not.toBeInTheDocument(),
  )
  expect(screen.getByText('Ordinary project chat')).toBeInTheDocument()
})
