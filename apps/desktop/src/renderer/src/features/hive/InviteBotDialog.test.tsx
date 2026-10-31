import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { roomFixture } from './room-fixture'
import type { RoomCreateInput } from './use-rooms'
import { InviteBotDialog } from './InviteBotDialog'

const HOST: Bot = {
  id: 'bot_a',
  name: 'Pixel',
  emoji: '🎨',
  personaMd: '# Pixel',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

const GUEST: Bot = { ...HOST, id: 'bot_b', name: 'Rover', emoji: '🛰️' }

const GUEST_WITHOUT_PROJECT: Bot = {
  ...HOST,
  id: 'bot_c',
  name: 'Ghost',
  emoji: '👻',
  projectId: undefined,
}

function renderInvite(
  options: {
    bots?: Bot[]
    rooms?: TeamRoomSummary[]
    onCreate?: (input: RoomCreateInput) => Promise<TeamRoomSummary>
  } = {},
) {
  const onCreate =
    options.onCreate ?? vi.fn(async (input: RoomCreateInput) => roomFixture({ title: input.title }))
  const onCreated = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <InviteBotDialog
      open
      onOpenChange={onOpenChange}
      host={HOST}
      bots={options.bots ?? [GUEST, GUEST_WITHOUT_PROJECT]}
      rooms={options.rooms ?? []}
      onCreate={onCreate}
      onCreated={onCreated}
    />,
  )
  return { onCreate, onCreated, onOpenChange }
}

describe('InviteBotDialog', () => {
  /** The dialog fades in; tests wait for it rather than racing the motion. */
  async function openDialog(): Promise<void> {
    await screen.findByRole('dialog', { name: 'Invite a bot' })
  }

  it('lists everyone but the host', async () => {
    renderInvite()
    await openDialog()

    expect(screen.getByRole('button', { name: /Rover/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ghost/ })).toBeInTheDocument()
  })

  it('will not seat a bot that has no project to work in', async () => {
    renderInvite()
    await openDialog()

    const row = screen.getByText('Ghost').closest('button')
    expect(row).toHaveAttribute('disabled')
    expect(screen.getByText('Needs a project')).toBeInTheDocument()
  })

  it('is an empty answer when there is nobody else on the team', async () => {
    renderInvite({ bots: [HOST] })
    await openDialog()

    expect(screen.getByText('Create another bot to invite.')).toBeInTheDocument()
  })

  it('creates a fresh lead-less room for the pair', async () => {
    const { onCreate, onCreated, onOpenChange } = renderInvite()

    await userEvent.click(screen.getByRole('button', { name: /Rover/ }))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Pixel × Rover',
      botIds: ['bot_a', 'bot_b'],
      leadBotId: null,
    })
    expect(onCreated).toHaveBeenCalledWith(roomFixture({ title: 'Pixel × Rover' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reuses the pair room instead of seating a twin', async () => {
    const pair = roomFixture({
      title: 'Pixel × Rover',
      leadBotId: null,
      bots: [
        { botId: 'bot_a', name: 'Pixel', emoji: '🎨', sessionId: 'thr_1' },
        { botId: 'bot_b', name: 'Rover', emoji: '🛰️', sessionId: 'thr_2' },
      ],
    })
    const { onCreate, onCreated } = renderInvite({ rooms: [pair] })

    await userEvent.click(screen.getByRole('button', { name: /Rover/ }))

    expect(onCreate).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith(pair)
  })

  it('shows a failed create instead of dying', async () => {
    renderInvite({
      onCreate: vi.fn(async () => {
        throw new Error('the room refused')
      }),
    })

    await userEvent.click(screen.getByRole('button', { name: /Rover/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('the room refused')
  })
})
