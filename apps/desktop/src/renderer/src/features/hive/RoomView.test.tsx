import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { characterFromSeed } from '@ari/ui/bot-character'
import { roomFixture } from './room-fixture'
import { RoomView } from './RoomView'
import { useRooms, type RoomSendResult } from './use-rooms'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock
const subscribeMock = rpcMocks.subscribe as unknown as Mock

const SENT: RoomSendResult = { targets: ['bot_a'], pick: false, queued: false }

const TALKED = roomFixture({
  leadBotId: 'bot_a',
  log: [
    { id: 'e1', botId: null, text: 'Ship the banner', at: 1 },
    { id: 'e2', botId: 'bot_a', text: 'On it — **bold** plan.', at: 2 },
    { id: 'e3', botId: 'bot_b', text: '(pass)', at: 3 },
  ],
})

function renderRoom(room: TeamRoomSummary, onSend: Mock = vi.fn(async () => SENT)) {
  const onRemove = vi.fn(async () => true)
  const onOpenThread = vi.fn()
  const view = render(
    <RoomView room={room} onSend={onSend} onRemove={onRemove} onOpenThread={onOpenThread} />,
  )
  return { ...view, onSend, onRemove, onOpenThread }
}

beforeEach(() => {
  invokeMock.mockReset()
  subscribeMock.mockReset()
})

describe('RoomView', () => {
  it('shows the members and who said what', () => {
    renderRoom(TALKED)

    expect(screen.getByRole('heading', { name: 'Launch' })).toBeInTheDocument()
    const members = screen.getByRole('list', { name: 'Members' })
    expect(within(members).getByText('Pixel')).toBeInTheDocument()
    expect(within(members).getByText('Lead')).toBeInTheDocument()

    const transcript = screen.getByRole('log', { name: 'Room transcript' })
    expect(within(transcript).getByText('Ship the banner')).toBeInTheDocument()
    expect(within(transcript).getByText('bold').tagName).toBe('STRONG')
    expect(within(transcript).getByText('Rover passed')).toBeInTheDocument()
  })

  it('opens a member thread from its chip', async () => {
    const { onOpenThread } = renderRoom(TALKED)

    await userEvent.click(screen.getByRole('button', { name: "Open Rover's thread" }))
    expect(onOpenThread).toHaveBeenCalledWith('thread_b')
  })

  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const { onSend } = renderRoom(TALKED)
    const field = screen.getByRole('textbox', { name: 'Message the room' })

    await userEvent.type(field, 'first{Shift>}{Enter}{/Shift}second')
    expect(field).toHaveValue('first\nsecond')
    await userEvent.type(field, '{Enter}')

    expect(onSend).toHaveBeenCalledWith({ roomId: 'room_1', text: 'first\nsecond' })
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('inserts a mention from a member chip', async () => {
    renderRoom(TALKED)
    const field = screen.getByRole('textbox', { name: 'Message the room' })

    await userEvent.type(field, 'ask')
    await userEvent.click(screen.getByRole('button', { name: 'Mention Rover' }))
    expect(field).toHaveValue('ask @Rover ')
  })

  it('shows a failed send under the field and keeps the draft', async () => {
    renderRoom(
      TALKED,
      vi.fn(async () => {
        throw new Error('Room is gone')
      }),
    )
    const field = screen.getByRole('textbox', { name: 'Message the room' })

    await userEvent.type(field, 'hello{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Room is gone')
    expect(field).toHaveValue('hello')
  })

  it('asks who should answer, and re-sends to the bot picked', async () => {
    const onSend = vi.fn(async (input: { botId?: string }) =>
      input.botId === undefined ? { targets: [], pick: true, queued: false } : SENT,
    )
    renderRoom(roomFixture(), onSend)

    await userEvent.type(screen.getByRole('textbox', { name: 'Message the room' }), 'hi{Enter}')
    const prompt = await screen.findByRole('group', { name: 'Pick a bot' })
    await userEvent.click(within(prompt).getByRole('button', { name: 'Ask Rover' }))

    expect(onSend).toHaveBeenLastCalledWith({ roomId: 'room_1', text: 'hi', botId: 'bot_b' })
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Pick a bot' })).not.toBeInTheDocument(),
    )
  })

  it('says who needs the person', () => {
    renderRoom(
      roomFixture({
        needsUser: true,
        log: [{ id: 'e1', botId: 'bot_b', text: '@user which colour?', at: 1 }],
      }),
    )
    const note = screen.getByText('Rover needs you')
    expect(note.querySelector('svg.ari-bot')).toHaveAttribute('data-mood', 'needs-you')
    const members = screen.getByRole('list', { name: 'Members' })
    const rover = within(members).getByText('Rover').closest('li')
    expect(rover?.querySelector('svg.ari-bot')).toHaveAttribute('data-mood', 'needs-you')
  })

  it('draws every member in its look, wherever a face shows', () => {
    const room = roomFixture({
      bots: [
        {
          botId: 'bot_a',
          name: 'Pixel',
          emoji: '🎨',
          character: { shape: 'pebble', palette: 5 },
          sessionId: 'thread_a',
        },
        { botId: 'bot_b', name: 'Rover', emoji: '🛰️', sessionId: 'thread_b' },
      ],
      log: [{ id: 'e1', botId: 'bot_a', text: 'Hello.', at: 1 }],
    })
    renderRoom(room)

    const members = screen.getByRole('list', { name: 'Members' })
    const faces = [...members.querySelectorAll('svg.ari-bot')]
    expect(faces.map((face) => face.getAttribute('data-shape'))).toEqual([
      'pebble',
      characterFromSeed('bot_b').shape,
    ])
    const transcript = screen.getByRole('log', { name: 'Room transcript' })
    expect(transcript.querySelector('svg.ari-bot')).toHaveAttribute('data-palette', '5')
    const mention = screen.getByRole('button', { name: 'Mention Pixel' })
    expect(mention.querySelector('svg.ari-bot')).toHaveAttribute('data-shape', 'pebble')
    // No emoji is left standing in for a face.
    expect(screen.queryByText('🎨')).not.toBeInTheDocument()
  })

  it('says who is replying and how many messages wait', () => {
    renderRoom(
      roomFixture({
        pending: 2,
        round: { rounds: 1, messages: 1, followUps: 0, awaiting: ['bot_b'], passed: [] },
      }),
    )
    expect(screen.getByText('Rover is replying…')).toBeInTheDocument()
    expect(screen.getByText('2 messages waiting for the room to settle')).toBeInTheDocument()
    const members = screen.getByRole('list', { name: 'Members' })
    expect(within(members).getByRole('status', { name: 'Working' })).toBeInTheDocument()
    const rover = within(members).getByText('Rover').closest('li')
    expect(rover?.querySelector('svg.ari-bot')).toHaveAttribute('data-mood', 'replying')
  })

  it('deletes only once the delete is confirmed', async () => {
    const { onRemove } = renderRoom(TALKED)

    await userEvent.click(screen.getByRole('button', { name: 'Delete Launch' }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep Launch' }))
    expect(onRemove).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Launch' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete Launch' }))
    expect(onRemove).toHaveBeenCalledWith('room_1')
  })
})

describe('RoomView on the live store', () => {
  function LiveRoom() {
    const store = useRooms()
    const room = store.rooms[0]
    if (room === undefined) return <p>No room</p>
    return (
      <RoomView
        room={room}
        onSend={store.send}
        onRemove={store.remove}
        onOpenThread={() => undefined}
      />
    )
  }

  it('updates the transcript from rooms.updated and leaves on removal', async () => {
    let push: (payload: unknown) => void = () => undefined
    subscribeMock.mockImplementation((_name: string, _params: unknown, onEvent: typeof push) => {
      push = onEvent
      return () => undefined
    })
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'rooms.list') return [roomFixture()]
      if (method === 'rooms.send') return SENT
      return undefined
    })
    render(<LiveRoom />)

    const field = await screen.findByRole('textbox', { name: 'Message the room' })
    await userEvent.type(field, 'Hello @Pixel{Enter}')
    expect(invokeMock).toHaveBeenCalledWith('rooms.send', {
      roomId: 'room_1',
      text: 'Hello @Pixel',
    })

    act(() =>
      push({
        roomId: 'room_1',
        room: roomFixture({
          log: [
            { id: 'e1', botId: null, text: 'Hello @Pixel', at: 1 },
            { id: 'e2', botId: 'bot_a', text: 'Hi there', at: 2 },
          ],
        }),
      }),
    )
    expect(screen.getByText('Hi there')).toBeInTheDocument()

    act(() => push({ roomId: 'room_1', room: null }))
    expect(screen.getByText('No room')).toBeInTheDocument()
  })
})
