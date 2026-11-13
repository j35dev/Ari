import { useCallback, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { useToast } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'
import { iconButton } from '../../lib/recipes'

/**
 * Header action while one turn is the review scope: restores the workspace to
 * the checkpoint captured before that turn started, after a confirmation.
 */
export function TurnRevert({
  sessionId,
  turnId,
  label,
  disabledReason,
  onReverted,
}: {
  sessionId: string
  turnId: string
  /** "Turn 3", as the scope menu names it. */
  label: string
  disabledReason?: string | null
  onReverted: () => void
}) {
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  busy.current = pending
  const onOpenChange = useCallback((open: boolean) => {
    if (!open && !busy.current) setConfirming(false)
  }, [])
  const revert = (): void => {
    setPending(true)
    void rpc
      .invoke('command.dispatch', {
        command: { type: 'checkpoint.revert', sessionId, turnId },
      })
      .then((result) => {
        if (!result.accepted) throw new Error('engine rejected the revert')
        toast({
          title: 'Workspace reverted',
          description: `Restored to before ${label}.`,
          tone: 'success',
        })
        onReverted()
      })
      .catch(() => {
        toast({
          title: 'Revert failed',
          description: `The workspace was not restored to before ${label}.`,
          tone: 'danger',
        })
      })
      .finally(() => {
        setPending(false)
        setConfirming(false)
      })
  }
  return (
    <>
      <button
        type="button"
        aria-label="Revert to before this turn"
        title={disabledReason ?? `Revert the workspace to before ${label}`}
        disabled={Boolean(disabledReason) || pending}
        onClick={() => setConfirming(true)}
        className={iconButton}
      >
        <RotateCcw size={14} aria-hidden />
      </button>
      <Dialog open={confirming} onOpenChange={onOpenChange}>
        <Dialog.Content>
          <Dialog.Title>Revert to before {label}?</Dialog.Title>
          <Dialog.Description>
            Ari restores the workspace to the checkpoint taken before this turn started. Changes
            made since then are replaced.
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button size="sm" variant="danger" loading={pending} onClick={revert}>
              Revert
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </>
  )
}
