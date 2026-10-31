import { useState } from 'react'
import type { Bot } from '@ari/contracts/bot'
import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { characterOf } from '@ari/ui/bot-character'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { dmRoomOf } from './team-room'
import type { RoomCreateInput } from './use-rooms'

export interface InviteBotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bot the DM opens from; every row seats someone else. */
  host: Bot
  /** The roster it picks a teammate from: the guests. */
  bots: readonly Bot[]
  /** The rooms the store already knows, so a pair reuses its room. */
  rooms: readonly TeamRoomSummary[]
  onCreate: (input: RoomCreateInput) => Promise<TeamRoomSummary>
  /** Fired with the room — reused or fresh — so the shell can open it. */
  onCreated: (room: TeamRoomSummary) => void
}

/**
 * A bot DM: exactly two bots in a room with no lead — they hand off to each
 * other by `@mention` and call the person in with `@user`. An existing room
 * for the pair opens as is, so one conversation does not sprout twins.
 */
export function InviteBotDialog({
  open,
  onOpenChange,
  host,
  bots,
  rooms,
  onCreate,
  onCreated,
}: InviteBotDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Everyone but the host; a bot needs a project to hold a thread in. */
  const guests = bots.filter((bot) => bot.id !== host.id)

  const invite = async (guest: Bot): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const room =
        dmRoomOf(rooms, host.id, guest.id) ??
        (await onCreate({
          title: `${host.name} × ${guest.name}`,
          botIds: [host.id, guest.id],
          leadBotId: null,
        }))
      onOpenChange(false)
      onCreated(room)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="w-[min(24rem,92vw)]">
        <Dialog.Title>Invite a bot</Dialog.Title>
        <Dialog.Description>
          Two bots in a room, no lead. They hand off to each other and can pull you in with @user.
        </Dialog.Description>

        {guests.length === 0 ? (
          <p className="mt-4 text-xs text-fg-muted">Create another bot to invite.</p>
        ) : (
          <div className="ari-scroll mt-4 flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-surface-1 p-1">
            {guests.map((guest) => (
              <Button
                key={guest.id}
                type="button"
                variant="ghost"
                loading={busy}
                disabled={busy || guest.projectId === undefined}
                onClick={() => {
                  void invite(guest)
                }}
                className="justify-start rounded-sm px-2 py-1.5"
              >
                <BotAvatar character={characterOf(guest)} size={20} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-fg">{guest.name}</span>
                  {guest.projectId === undefined ? (
                    <span className="block truncate text-2xs text-fg-subtle">Needs a project</span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        )}

        {error !== null ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-3 flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
