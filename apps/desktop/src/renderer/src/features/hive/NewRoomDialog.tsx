import { useState } from 'react'
import type { Bot } from '@ari/contracts/bot'
import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Checkbox } from '@ari/ui/checkbox'
import { Dialog } from '@ari/ui/dialog'
import { Field } from '@ari/ui/field'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import type { RoomCreateInput } from './use-rooms'

/** The host seats at most this many bots in one room (`rooms.create`). */
export const ROOM_MAX_BOTS = 8

const NO_LEAD = ''

export interface NewRoomDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bots that can be seated: the roster, hidden bots left out. */
  bots: readonly Bot[]
  onCreate: (input: RoomCreateInput) => Promise<TeamRoomSummary>
  /** Fired with the new room so the shell can open it. */
  onCreated: (room: TeamRoomSummary) => void
}

/**
 * Seats a few bots in one room: a title, who is in it, and optionally who
 * leads. The lead takes any message nobody in particular was addressed in;
 * without one the room asks the person to pick.
 */
export function NewRoomDialog({
  open,
  onOpenChange,
  bots,
  onCreate,
  onCreated,
}: NewRoomDialogProps) {
  const [title, setTitle] = useState('')
  const [memberIds, setMemberIds] = useState<readonly string[]>([])
  const [leadPick, setLeadPick] = useState(NO_LEAD)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedTitle = title.trim()
  // Seat order follows the roster, not the order the boxes were ticked.
  const members = bots.filter((bot) => memberIds.includes(bot.id))
  const leadBotId = members.some((bot) => bot.id === leadPick) ? leadPick : NO_LEAD
  const full = members.length >= ROOM_MAX_BOTS
  const valid = trimmedTitle.length > 0 && members.length > 0 && members.length <= ROOM_MAX_BOTS

  const toggle = (botId: string, checked: boolean): void => {
    setMemberIds((prev) =>
      checked
        ? prev.includes(botId)
          ? prev
          : [...prev, botId]
        : prev.filter((id) => id !== botId),
    )
  }

  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const room = await onCreate({
        title: trimmedTitle,
        botIds: members.map((bot) => bot.id),
        leadBotId: leadBotId === NO_LEAD ? null : leadBotId,
      })
      onOpenChange(false)
      setTitle('')
      setMemberIds([])
      setLeadPick(NO_LEAD)
      onCreated(room)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-label="New room" className="w-[min(30rem,92vw)]">
        <Dialog.Title>New room</Dialog.Title>
        <Dialog.Description>
          Talk to several bots in one place. They answer one at a time and can hand off to each
          other.
        </Dialog.Description>

        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field label="Title">
            {(control) => (
              <Input
                {...control}
                autoFocus
                value={title}
                placeholder="Launch week"
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-fg">Members</legend>
            {bots.length === 0 ? (
              <p className="text-xs text-danger">Create a bot first.</p>
            ) : (
              <div className="ari-scroll flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-surface-1 p-1">
                {bots.map((bot) => {
                  const checked = memberIds.includes(bot.id)
                  return (
                    <Checkbox
                      key={bot.id}
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(event) => toggle(bot.id, event.target.checked)}
                      className="rounded-sm px-2 py-1.5 hover:bg-surface-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                    >
                      <span aria-hidden="true" className="text-sm leading-none">
                        {bot.emoji}
                      </span>
                      <span className="truncate text-sm text-fg">{bot.name}</span>
                    </Checkbox>
                  )
                })}
              </div>
            )}
            <p className="text-xs text-fg-muted">
              {full
                ? `A room seats up to ${ROOM_MAX_BOTS} bots.`
                : `Pick 1 to ${ROOM_MAX_BOTS} bots.`}
            </p>
          </fieldset>

          <Field
            label="Lead"
            hint="Answers anything not addressed to someone. Without a lead you pick each time."
          >
            {(control) => (
              <Select
                {...control}
                aria-label="Lead"
                value={leadBotId}
                options={[
                  { value: NO_LEAD, label: 'No lead' },
                  ...members.map((bot) => ({ value: bot.id, label: `${bot.emoji} ${bot.name}` })),
                ]}
                onValueChange={setLeadPick}
              />
            )}
          </Field>

          {error !== null ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={busy || !valid}>
              Create room
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog>
  )
}
