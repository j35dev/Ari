import { useState } from 'react'
import type { Bot, BotUpdatePatch } from '@ari/contracts/bot'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { BotIdentityFields } from './BotIdentityFields'
import { BotLookEditor } from './BotLookEditor'
import { draftFromBot, patchOf, type BotDraft } from './bot-draft'

export interface EditBotDialogProps {
  /** The bot being edited; null keeps the dialog closed. */
  bot: Bot | null
  onClose: () => void
  onSave: (botId: string, patch: BotUpdatePatch) => Promise<Bot>
}

function EditBotForm({
  bot,
  onClose,
  onSave,
}: {
  bot: Bot
  onClose: () => void
  onSave: EditBotDialogProps['onSave']
}) {
  const [draft, setDraft] = useState<BotDraft>(() => draftFromBot(bot))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = draft.name.trim()
  const title = draft.title.trim()
  const tagline = draft.tagline.trim()
  const patch = patchOf(bot, draft)
  const changed = Object.keys(patch).length > 0

  const submit = async (): Promise<void> => {
    if (name.length === 0 || busy) return
    if (!changed) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave(bot.id, patch)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-4">
        <div className="flex size-28 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-1">
          <BotAvatar character={draft.character} size={96} label={`${name || bot.name} preview`} />
        </div>
        <div className="min-w-0 flex-1">
          {/* The heading shows the live name; the dialog is announced by the saved one. */}
          <Dialog.Title aria-label={`Edit ${bot.name}`} className="truncate">
            {name.length > 0 ? name : bot.name}
          </Dialog.Title>
          {title.length > 0 ? <p className="truncate text-sm text-fg-muted">{title}</p> : null}
          <Dialog.Description className="mt-1 line-clamp-2 text-xs text-fg-subtle">
            {tagline.length > 0 ? tagline : 'Change how this bot looks and who it is.'}
          </Dialog.Description>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <BotLookEditor
          value={draft.character}
          preview={false}
          onChange={(character) => setDraft((prev) => ({ ...prev, character }))}
        />

        <BotIdentityFields
          draft={draft}
          onChange={(change) => setDraft((prev) => ({ ...prev, ...change }))}
        />

        {error !== null ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={busy || name.length === 0}
          >
            Save
          </Button>
        </div>
      </form>
    </>
  )
}

/**
 * Edits a bot's look and identity: shape, colour, name, title, tagline and
 * persona. The driver, model and project stay as the bot was created.
 */
export function EditBotDialog({ bot, onClose, onSave }: EditBotDialogProps) {
  // Holds the last bot through the close animation so the panel does not empty as it fades.
  const [shown, setShown] = useState(bot)
  if (bot !== null && bot !== shown) setShown(bot)
  return (
    <Dialog
      open={bot !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Content
        aria-label={shown === null ? 'Edit bot' : `Edit ${shown.name}`}
        className="ari-scroll max-h-[90vh] w-[min(36rem,92vw)] overflow-y-auto"
      >
        {/* Keyed so reopening on another bot starts from that bot, not the last draft. */}
        {shown === null ? null : (
          <EditBotForm key={shown.id} bot={shown} onClose={onClose} onSave={onSave} />
        )}
      </Dialog.Content>
    </Dialog>
  )
}
