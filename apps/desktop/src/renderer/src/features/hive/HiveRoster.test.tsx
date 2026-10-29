import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { characterFromSeed } from '@ari/ui/bot-character'
import type { SessionSummary, TeamRoomSummary } from '@ari/contracts/rpc'
import type { SessionActivity } from '../session/session-activity'
import { HiveRoster } from './HiveRoster'
import { ASLEEP_AFTER_MS } from './bot-mood'
import { roomFixture } from './room-fixture'
import { STARTER_CAST } from './starter-cast'
import type { RoomsStore } from './use-rooms'

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

const ROVER: Bot = { ...BOT, id: 'bot_b', name: 'Rover', emoji: '🛰️', mainSessionId: 'sess_2' }

function roomsStore(rooms: TeamRoomSummary[] = [], created?: TeamRoomSummary): RoomsStore {
  return {
    rooms,
    loading: false,
    error: null,
    create: vi.fn(async () => created ?? roomFixture()),
    send: vi.fn(async () => ({ targets: [], pick: false, queued: false })),
    remove: vi.fn(async () => true),
  }
}

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
    if (method === 'bots.update') return bots[0]
    if (method === 'providers.detect' || method === 'endpoints.list') return []
    if (method === 'providers.models') return {}
    return undefined
  })
}

function renderRoster(
  options: {
    activityOf?: (sessionId: string) => SessionActivity | undefined
    sessions?: SessionSummary[]
    rooms?: RoomsStore
    activeRoomId?: string | null
  } = {},
) {
  const onOpenSession = vi.fn()
  const onSessionsChanged = vi.fn()
  const onOpenRoom = vi.fn()
  const rooms = options.rooms ?? roomsStore()
  render(
    <HiveRoster
      sessions={options.sessions ?? [SESSION]}
      projects={PROJECTS}
      activityOf={options.activityOf}
      defaults={{ driverKind: 'ari-core', modelId: null }}
      onOpenSession={onOpenSession}
      onSessionsChanged={onSessionsChanged}
      rooms={rooms}
      activeRoomId={options.activeRoomId}
      onOpenRoom={onOpenRoom}
    />,
  )
  return { onOpenSession, onSessionsChanged, onOpenRoom, rooms }
}

beforeEach(() => {
  invokeMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The avatar in a roster row; decoration, so it is found by class rather than role. */
function avatarOf(name: string): SVGElement {
  const row = screen.getByText(name).closest('[role="listitem"]')
  const svg = row?.querySelector('svg.ari-bot')
  if (svg === null || svg === undefined) throw new Error(`no avatar for ${name}`)
  return svg as SVGElement
}

describe('HiveRoster', () => {
  it('lists a bot with its face, name and what it last said', async () => {
    stubBots([BOT])
    renderRoster()

    expect(await screen.findByText('Pixel')).toBeInTheDocument()
    expect(avatarOf('Pixel')).toHaveAttribute('data-shape', characterFromSeed('bot_1').shape)
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
        character: characterFromSeed('bot_1'),
        personaMd: '# Pixel',
        driverKind: 'ari-core',
        modelId: null,
        projectId: 'proj_1',
      }),
    )
  })

  it('creates a bot from the dialog and opens the session it came with', async () => {
    stubBots([], { ...BOT, id: 'bot_9', name: 'Rover', mainSessionId: 'sess_9' })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const { onOpenSession, onSessionsChanged } = renderRoster({ sessions: [] })

    await userEvent.click(await screen.findByRole('button', { name: /New bot/ }))
    await userEvent.type(screen.getByLabelText('Name'), '  Rover ')
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bots.create', {
        name: 'Rover',
        emoji: '🤖',
        character: { shape: 'drop', palette: 0 },
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

describe('HiveRoster looks', () => {
  const FORGE: Bot = {
    ...BOT,
    id: 'bot_f',
    name: 'Forge',
    title: 'Builder',
    character: { shape: 'drop', palette: 6 },
    mainSessionId: 'sess_f',
  }
  const SIFT: Bot = { ...BOT, id: 'bot_s', name: 'Sift', mainSessionId: 'sess_s' }

  it('draws each bot in its look, with a mood from its main session', async () => {
    stubBots([BOT, FORGE, ROVER, SIFT])
    const now = Date.now()
    renderRoster({
      sessions: [
        { ...SESSION, updatedAt: now },
        { ...SESSION, id: 'sess_f', updatedAt: now },
        { ...SESSION, id: 'sess_2', updatedAt: now },
        { ...SESSION, id: 'sess_s', updatedAt: now - ASLEEP_AFTER_MS - 60_000 },
      ],
      activityOf: (sessionId) =>
        sessionId === 'sess_f'
          ? { phase: 'working', startedAt: 1 }
          : sessionId === 'sess_2'
            ? { phase: 'paused', startedAt: 1, pauseReason: 'approval' }
            : undefined,
    })

    await screen.findByText('Forge')
    expect(avatarOf('Forge')).toHaveAttribute('data-mood', 'working')
    expect(avatarOf('Forge')).toHaveAttribute('data-shape', 'drop')
    expect(avatarOf('Forge')).toHaveAttribute('data-palette', '6')
    expect(avatarOf('Rover')).toHaveAttribute('data-mood', 'needs-you')
    expect(avatarOf('Sift')).toHaveAttribute('data-mood', 'asleep')
    expect(avatarOf('Pixel')).toHaveAttribute('data-mood', 'idle')
    // A bot made before characters wears the look its id derives.
    expect(avatarOf('Pixel')).toHaveAttribute('data-shape', characterFromSeed('bot_1').shape)
  })

  it('shows a title before what the bot last said', async () => {
    stubBots([{ ...FORGE, mainSessionId: 'sess_1' }])
    renderRoster()

    expect(await screen.findByText('Builder')).toBeInTheDocument()
    expect(screen.getByText('Builder').parentElement).toHaveTextContent(
      'Builder · Read the file and fixed it.',
    )
  })

  it('creates a bot from a starter with its look, title and tagline', async () => {
    stubBots([], { ...BOT, id: 'bot_9', name: 'Lint', mainSessionId: 'sess_9' })
    renderRoster({ sessions: [] })
    const lint = STARTER_CAST.find((starter) => starter.id === 'lint')!

    await userEvent.click(await screen.findByRole('button', { name: /New bot/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New bot' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lint' }))

    expect(within(dialog).getByLabelText('Name')).toHaveValue('Lint')
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Reviewer')
    expect(within(dialog).getByLabelText('Tagline')).toHaveValue(lint.tagline)
    expect(within(dialog).getByLabelText('Persona')).toHaveValue(lint.personaMd)
    expect(within(dialog).getByRole('img', { name: 'Lint preview' })).toHaveAttribute(
      'data-shape',
      'pill',
    )
    expect(within(dialog).getByRole('radio', { name: 'Sage' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await userEvent.click(within(dialog).getByRole('radio', { name: 'Sky' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bots.create', {
        name: 'Lint',
        emoji: '🤖',
        character: { shape: 'pill', palette: 8 },
        title: 'Reviewer',
        tagline: lint.tagline,
        personaMd: lint.personaMd,
        driverKind: 'ari-core',
        modelId: null,
        projectId: 'proj_1',
      }),
    )
  })

  it('goes back to a blank bot from a starter', async () => {
    stubBots([])
    renderRoster({ sessions: [] })

    await userEvent.click(await screen.findByRole('button', { name: /New bot/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New bot' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Scout' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Blank' }))

    expect(within(dialog).getByLabelText('Name')).toHaveValue('')
    expect(within(dialog).getByLabelText('Persona')).toHaveValue('')
    expect(within(dialog).getByRole('button', { name: 'Blank' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('edits a bot and saves only what changed through bots.update', async () => {
    stubBots([FORGE])
    renderRoster({ sessions: [] })
    await screen.findByText('Forge')

    await userEvent.click(screen.getByRole('button', { name: 'Edit Forge' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Forge' })
    expect(within(dialog).getByRole('img', { name: 'Forge preview' })).toHaveAttribute(
      'data-shape',
      'drop',
    )

    await userEvent.click(within(dialog).getByRole('radio', { name: 'Gumdrop' }))
    expect(within(dialog).getByRole('img', { name: 'Forge preview' })).toHaveAttribute(
      'data-shape',
      'gumdrop',
    )
    await userEvent.clear(within(dialog).getByLabelText('Title'))
    await userEvent.type(within(dialog).getByLabelText('Tagline'), 'Ships it.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('bots.update', {
        botId: 'bot_f',
        patch: { title: '', tagline: 'Ships it.', character: { shape: 'gumdrop', palette: 6 } },
      }),
    )
    // The store re-reads the roster after a write.
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([method]) => method === 'bots.list')).toHaveLength(2),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit Forge' })).not.toBeInTheDocument(),
    )
  })

  it('shows a failed save inside the edit dialog', async () => {
    stubBots([FORGE])
    renderRoster({ sessions: [] })
    await screen.findByText('Forge')
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'bots.update') throw new Error('Bot not found')
      if (method === 'bots.list') return [FORGE]
      return []
    })

    await userEvent.click(screen.getByRole('button', { name: 'Edit Forge' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Forge' })
    await userEvent.type(within(dialog).getByLabelText('Name'), '2')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Bot not found')
  })

  it('duplicates a bot with its look, title and tagline', async () => {
    stubBots([{ ...FORGE, tagline: 'Ships it.' }])
    renderRoster({ sessions: [] })
    await screen.findByText('Forge')

    await userEvent.click(screen.getByRole('button', { name: 'Duplicate Forge' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'bots.create',
        expect.objectContaining({
          name: 'Forge copy',
          character: { shape: 'drop', palette: 6 },
          title: 'Builder',
          tagline: 'Ships it.',
        }),
      ),
    )
  })
})

describe('HiveRoster rooms', () => {
  it('lists each room with its members and opens it', async () => {
    stubBots([BOT, ROVER])
    const { onOpenRoom } = renderRoster({ rooms: roomsStore([roomFixture()]) })

    const list = await screen.findByRole('list', { name: 'Rooms' })
    expect(within(list).getByText('Launch')).toBeInTheDocument()
    const faces = within(list).getAllByRole('listitem')[0]!.querySelectorAll('svg.ari-bot')
    expect([...faces].map((face) => face.getAttribute('data-shape'))).toEqual([
      characterFromSeed('bot_a').shape,
      characterFromSeed('bot_b').shape,
    ])

    await userEvent.click(within(list).getByRole('button', { name: /Launch/ }))
    expect(onOpenRoom).toHaveBeenCalledWith('room_1')
  })

  it('marks a room that needs the person and one that is working', async () => {
    stubBots([BOT])
    renderRoster({
      rooms: roomsStore([
        roomFixture({ needsUser: true }),
        roomFixture({
          id: 'room_2',
          title: 'Docs',
          round: { rounds: 1, messages: 0, followUps: 0, awaiting: ['bot_a'], passed: [] },
        }),
      ]),
      activeRoomId: 'room_2',
    })

    const list = await screen.findByRole('list', { name: 'Rooms' })
    const [launch, docs] = within(list).getAllByRole('listitem')
    expect(within(launch!).getByText('Needs you')).toBeInTheDocument()
    expect(within(launch!).queryByRole('status')).not.toBeInTheDocument()
    expect(within(docs!).getByRole('status', { name: 'Working' })).toBeInTheDocument()
    const docsFaces = [...docs!.querySelectorAll('svg.ari-bot')]
    expect(docsFaces.map((face) => face.getAttribute('data-mood'))).toEqual(['replying', 'idle'])
    expect(within(docs!).getByRole('button', { name: /Docs/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('creates a room from the roster and opens it', async () => {
    stubBots([BOT, ROVER, { ...BOT, id: 'bot_h', name: 'Ghost', hidden: true }])
    const rooms = roomsStore([], roomFixture({ id: 'room_9', title: 'Launch week' }))
    const { onOpenRoom } = renderRoster({ rooms })

    await userEvent.click(screen.getByRole('button', { name: /New room/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New room' })
    const createButton = within(dialog).getByRole('button', { name: 'Create room' })
    // Hidden bots are not offered; nothing is valid until a title and a member are in.
    await within(dialog).findByRole('checkbox', { name: 'Pixel' })
    expect(within(dialog).queryByRole('checkbox', { name: 'Ghost' })).not.toBeInTheDocument()
    expect(createButton).toBeDisabled()

    await userEvent.type(within(dialog).getByLabelText('Title'), '  Launch week ')
    expect(createButton).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Rover' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Pixel' }))
    expect(createButton).toBeEnabled()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Lead' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Rover' }))
    await userEvent.click(createButton)

    // Seated in roster order, whatever order the boxes were ticked in.
    await waitFor(() =>
      expect(rooms.create).toHaveBeenCalledWith({
        title: 'Launch week',
        botIds: ['bot_1', 'bot_b'],
        leadBotId: 'bot_b',
      }),
    )
    expect(onOpenRoom).toHaveBeenCalledWith('room_9')
  })

  it('drops the lead when that bot leaves the room, and seats at most eight', async () => {
    const team = Array.from({ length: 9 }, (_, index) => ({
      ...BOT,
      id: `bot_${index}`,
      name: `Bot ${index}`,
    }))
    stubBots(team)
    const rooms = roomsStore()
    renderRoster({ rooms })

    await userEvent.click(screen.getByRole('button', { name: /New room/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New room' })
    await within(dialog).findByRole('checkbox', { name: 'Bot 0' })
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Crowd')
    for (const bot of team.slice(0, 8)) {
      await userEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    }
    expect(within(dialog).getByRole('checkbox', { name: 'Bot 8' })).toBeDisabled()
    expect(within(dialog).getByText('A room seats up to 8 bots.')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Lead' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Bot 0' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Bot 0' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create room' }))

    await waitFor(() =>
      expect(rooms.create).toHaveBeenCalledWith({
        title: 'Crowd',
        botIds: team.slice(1, 8).map((bot) => bot.id),
        leadBotId: null,
      }),
    )
  })

  it('shows a failed create inside the dialog', async () => {
    stubBots([BOT])
    const rooms = roomsStore()
    rooms.create = vi.fn(async () => {
      throw new Error('Too many rooms')
    })
    renderRoster({ rooms })

    await userEvent.click(screen.getByRole('button', { name: /New room/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New room' })
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Docs')
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'Pixel' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create room' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too many rooms')
  })
})
