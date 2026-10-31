import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { settingsSchema, type Settings, type SettingsUpdate } from '@ari/contracts/settings'
import { projectViewSchema, type Project } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'
import { App } from './App'
import { splitLayoutActions } from './features/split/use-split-layout'
import { loadLastPick } from './features/composer/last-pick'

const { invoke, subscribe } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('./lib/rpc', () => ({ rpc: { invoke, subscribe } }))
vi.mock('./features/session/SessionView', () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => <div>Opened session {sessionId}</div>,
}))
vi.mock('./features/focus', () => ({ FocusPill: () => null }))
const project = projectViewSchema.parse({
  id: 'project-ari',
  name: 'Ari',
  path: '/work/Ari',
  status: 'ok',
  open: true,
  createdAt: 1,
})
let settings: Settings
let projects: Project[]
let sessions: SessionSummary[]
beforeEach(() => {
  localStorage.clear()
  splitLayoutActions.reset()
  settings = settingsSchema.parse({ version: 1 })
  projects = []
  sessions = []
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    switch (method) {
      case 'ping':
        return 'pong'
      case 'app.info':
        return { platform: 'win32', homeDir: '/home/test', version: '0.3.8' }
      case 'settings.get':
        return settings
      case 'settings.update': {
        const patch = params as SettingsUpdate
        settings = settingsSchema.parse({
          ...settings,
          ...patch,
          sessions: { ...settings.sessions, ...patch.sessions },
        })
        return settings
      }
      case 'project.list':
        return projects
      case 'project.discover':
        return {
          projects: [
            { path: project.path, name: project.name, sources: ['claude'], lastUsedAt: 1 },
          ],
          truncated: false,
          warnings: [],
        }
      case 'project.open':
        projects = [project]
        return project
      case 'session.list':
        return sessions
      case 'session.create':
        sessions = [
          {
            id: 'onboarded',
            projectId: project.id,
            title: 'New session',
            messageCount: 0,
            updatedAt: 1,
          },
        ]
        return { sessionId: 'onboarded' }
      case 'session.workspace':
        return { path: project.path }
      case 'providers.detect':
        return [
          {
            kind: 'claude',
            installed: true,
            binaryPath: '/bin/claude',
            version: '2.1',
            authStatus: 'authenticated',
          },
        ]
      case 'providers.models':
      case 'endpoints.list':
        return []
      default:
        throw new Error(`Unexpected RPC: ${method}`)
    }
  })
})

describe('App onboarding integration', () => {
  it('finishes first run into the selected agent’s empty session, then reopens setup without losing it', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Meet your coding agents.' })
    await screen.findByText('Sign-in found')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Add Ari/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(
      await screen.findByText('Opened session onboarded', {}, { timeout: 10_000 }),
    ).toBeVisible()
    expect(settings.onboarding?.completedAt).toBeGreaterThan(0)
    expect(settings.sessions.defaultDriverKind).toBe('claude')
    expect(loadLastPick()?.driverKind).toBe('claude')
    expect(invoke.mock.calls.some(([method]) => method === 'command.dispatch')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run setup again' }))
    await screen.findByRole('heading', { name: 'Meet your coding agents.' })
    expect(screen.queryByText('Opened session onboarded')).not.toBeVisible()
    const count = invoke.mock.calls.length
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke.mock.calls.slice(count).some(([method]) => method === 'session.create')).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to workspace' }))
    expect(await screen.findByRole('button', { name: 'Run setup again' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Opened session onboarded')).toBeVisible()
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
  })

  it('remembers a skip across remounts without requiring an agent or project', async () => {
    const first = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }))
    await screen.findByRole('button', { name: 'Add a project to start' })
    first.unmount()
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Add a project to start' })).toBeVisible()
    expect(screen.queryByRole('main', { name: 'Ari setup' })).not.toBeInTheDocument()
    expect(projects).toHaveLength(0)
    expect(sessions).toHaveLength(0)
  })

  it('bypasses the wizard for an existing workspace and records its migration', async () => {
    projects = [project]
    render(<App />)
    await screen.findByRole('button', { name: 'Start a new session' })
    expect(screen.queryByRole('main', { name: 'Ari setup' })).not.toBeInTheDocument()
    await waitFor(() => expect(settings.onboarding?.completedAt).toBeGreaterThan(0))
    expect(invoke.mock.calls.some(([method]) => method === 'project.discover')).toBe(false)
  })
})
