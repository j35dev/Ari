import { useState, type ReactNode } from 'react'
import { Archive, Pin, PinOff } from 'lucide-react'
import type { SessionSummary } from '@ari/contracts/rpc'
import { BottomSheet } from '../../components/ui'
import { useApp } from '../../lib/app-state'

/** What a session row offers when it is pressed and held. */
export function SessionActions({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}): ReactNode {
  const app = useApp()
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const pinned = session.pinned === true
  async function run(command: { op: string; [field: string]: unknown }): Promise<void> {
    if (busy || app.session === null) return
    setBusy(true)
    setFailure(null)
    try {
      await app.session.send({ ...command, sessionId: session.id })
      await app.refresh()
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The computer refused that.')
      setBusy(false)
    }
  }
  const renamed = title.trim()
  return (
    <BottomSheet title={session.title || 'Untitled session'} onClose={onClose}>
      <form
        className="flex items-end gap-2 pb-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run({ op: 'session.update', title: renamed })
        }}
      >
        <label className="min-w-0 flex-1 text-xs text-fg-muted">
          Session name
          <input
            value={title}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
          />
        </label>
        <button
          type="submit"
          className="secondary-button min-h-12"
          disabled={busy || renamed.length === 0 || renamed === session.title}
        >
          Rename
        </button>
      </form>
      <ul className="border-t border-border py-1">
        <li>
          <button
            type="button"
            className="flex min-h-14 w-full items-center gap-3 text-left text-[15px]"
            disabled={busy}
            onClick={() => void run({ op: 'session.update', pinned: !pinned })}
          >
            {pinned ? <PinOff size={18} /> : <Pin size={18} />}
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        </li>
        {session.archived !== true && app.session?.supports('session.archive') === true && (
          <li>
            <button
              type="button"
              className="flex min-h-14 w-full items-center gap-3 text-left text-[15px] text-danger"
              disabled={busy}
              onClick={() => void run({ op: 'session.archive' })}
            >
              <Archive size={18} />
              Archive
            </button>
          </li>
        )}
      </ul>
      {failure !== null && (
        <p role="alert" className="error-banner">
          {failure}
        </p>
      )}
    </BottomSheet>
  )
}
