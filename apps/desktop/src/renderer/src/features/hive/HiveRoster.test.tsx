import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { SessionActivity } from '../session/session-activity'
import { HiveRoster } from './HiveRoster'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const BOT: Bot = {
  id: 'bot_1',
  name: 'Pixel',
  emoji: '🎨',
  personaMd: '# Pixel',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
  mainSessionId: 'sess_1',
}

const SESSION: SessionSummary = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Pixel',
  updatedAt: 2000,
  messageCount: 3,
  lastMessagePreview: 'Read  the file\nand fixed it.',
}

const PROJECTS = [{ id: 'proj_1', name: 'Ari' }]

/**
 * Answers `bots.list` with whatever the test says is on disk. The provider
 * catalogues the bot dialog's model picker reads come back empty: this suite
 * is about the roster, and an empty catalogue is a legitimate answer.
 */
function stubBots(bots: Bot[], created?: Bot): void {
  invokeMock.mockImplementation(async (method: string) => {
    if (method === 'bots.list') return bots
    if (method === 'bots.create') return created ?? bots[0]
    if (method === 'bots.setHidden') return bots[0]
    if (method === 'providers.detect' || method === 'endpoints.list') return []
    if (method === 'providers.models') return {}
    return undefined
  })
}

function renderRoster(
  options: {
    activityOf?: (sessionId: string) => SessionActivity | undefined
    sessions?: SessionSummary[]
    onCreate?: () => void
  } = {},
) {
  const onOpenSession = vi.fn()
  const onSessionsChanged = vi.fn()
  render(
    <HiveRoster
      sessions={options.sessions ?? [SESSION]}
      projects={PROJECTS}
      activityOf={options.activityOf}
      defaults={{ driverKind: 'ari-core', modelId: null }}
      onOpenSession={onOpenSession}
      onSessionsChanged={onSessionsChanged}
    />,
  )
  return { onOpenSession, onSessionsChanged }
}

beforeEach(() => {
  invokeMock.mockReset()
})

describe('HiveRoster', () => {
  it('lists a bot with its face, name and what it last said', async () => {
    stubBots([BOT])
    renderRoster()

    expect(await screen.findByText('Pixel')).toBeInTheDocument()
    expect(screen.getByText('🎨')).toBeInTheDocument()
    // Collapsed onto one line: the roster row is a single line of preview.
    expect(screen.getByText('Read the file and fixed it.')).toBeInTheDocument()
  })

  it('opens the bot main session when its row is clicked', async () => {
    stubBots([BOT])
    const { onOpenSession } = renderRoster()

    await userEvent.click(await screen.findByText('Pixel'))
    expect(onOpenSession).toHaveBeenCalledWith('sess_1')
  })

  it('shows what the bot is doing right now', async () => {
    stubBots([BOT])
    renderRoster({ activityOf: () => ({ phase: 'working', startedAt: 1000 }) })

    expect(await screen.findByRole('status', { name: 'Working' })).toBeInTheDocument()
  })

  it('hides a bot out of the roster without deleting it', async () => {
    stubBots([BOT])
    renderRoster()
    await screen.findByText('Pixel')

    // The next read reports the bot as hidden, as the store would.
    stubBots([{ ...BOT, hidden: true }])
    await userEvent.click(screen.getByRole('button', { name: 'Hide Pixel' }))

    expect(invokeMock).toHaveBeenCalledWith('bots.setHidden', { botId: 'bot_1', hidden: true })
    await waitFor(() => expect(screen.queryByText('Pixel')).not.toBeInTheDocument())
    // Kept, and reachable again rather than silently swallowed.
    expect(screen.getByRole('button', { name: /1 hidden/ })).toBeInTheDocument()
  })

  it('re-lists hidden bots on request', async () => {
    stubBots([{ ...BOT, hidden: true }])
    renderRoster()

    await userEvent.click(await screen.findByRole('button', { name: /1 hidden/ }))
    expect(await screen.findByText('Pixel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show Pixel' })).toBeInTheDocument()
  })

  it('duplicates a bot as a copy on the same project, persona and model', async () => {
    stubBots([BOT], { ...BOT, id: 'bot_2', name: 'Pixel copy', mainSessionId: 'sess_2' })
    renderRoster()
    await screen.findByText('Pixel')

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate Pixel' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bots.create', {
        name: 'Pixel copy',
        emoji: '🎨',
        personaMd: '# Pixel',
        driverKind: 'ari-core',
        modelId: null,
        projectId: 'proj_1',
      }),
    )
  })

  it('creates a bot from the dialog and opens the session it came with', async () => {
    stubBots([], { ...BOT, id: 'bot_9', name: 'Rover', mainSessionId: 'sess_9' })
    const { onOpenSession, onSessionsChanged } = renderRoster({ sessions: [] })

    await userEvent.click(await screen.findByRole('button', { name: /New bot/ }))
    await userEvent.type(screen.getByLabelText('Name'), 'Rover')
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bots.create', {
        name: 'Rover',
        emoji: '🤖',
        personaMd: '',
        driverKind: 'ari-core',
        modelId: null,
        projectId: 'proj_1',
      }),
    )
    expect(onSessionsChanged).toHaveBeenCalled()
    expect(onOpenSession).toHaveBeenCalledWith('sess_9')
  })

  it('asks for an empty roster rather than showing an empty team', async () => {
    stubBots([])
    renderRoster({ sessions: [] })

    expect(await screen.findByText('No bots yet')).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('bots.list')
  })
})
