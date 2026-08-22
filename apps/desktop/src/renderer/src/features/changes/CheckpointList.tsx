import { useCallback, useEffect, useState } from 'react'
import { Button } from '@ari/ui/button'
import { useToast } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'

interface CheckpointListProps {
  projectId: string
  sessionId: string
}

interface CheckpointInfo {
  turnId: string
  gitRef: string
}

interface RevertStatus {
  tone: 'success' | 'danger'
  message: string
}

/** Narrow an untyped `session.load` read model down to its checkpoints array. */
function readCheckpoints(model: unknown): CheckpointInfo[] {
  if (typeof model !== 'object' || model === null) return []
  const raw = (model as { checkpoints?: unknown }).checkpoints
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is CheckpointInfo =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as CheckpointInfo).turnId === 'string' &&
      typeof (entry as CheckpointInfo).gitRef === 'string',
  )
}

/**
 * Checkpoint history for one session: a mono row per captured turn, each with
 * an inline-confirm revert. Confirming dispatches `checkpoint.revert` to the
 * engine and reports the outcome via toast plus an inline status line.
 */
export function CheckpointList({ projectId: _projectId, sessionId }: CheckpointListProps) {
  const { toast } = useToast()
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirmingTurnId, setConfirmingTurnId] = useState<string | null>(null)
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null)
  const [status, setStatus] = useState<RevertStatus | null>(null)

  const loadCheckpoints = useCallback((): void => {
    void rpc
      .invoke('session.load', { sessionId })
      .then((model) => {
        setCheckpoints(readCheckpoints(model))
        setLoadError(null)
      })
      .catch(() => setLoadError('Could not load checkpoints.'))
      .finally(() => setLoaded(true))
  }, [sessionId])

  useEffect(loadCheckpoints, [loadCheckpoints])

  const handleRevert = useCallback(
    (turnId: string): void => {
      setPendingTurnId(turnId)
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'checkpoint.revert', sessionId, turnId },
        })
        .then((result) => {
          if (!result.accepted) throw new Error('engine rejected the revert')
          setStatus({ tone: 'success', message: `Workspace reverted to ${turnId}.` })
          toast({
            title: 'Workspace reverted',
            description: `Turn ${turnId} restored.`,
            tone: 'success',
          })
          loadCheckpoints()
        })
        .catch(() => {
          setStatus({
            tone: 'danger',
            message: `Revert to ${turnId} failed — workspace untouched.`,
          })
          toast({
            title: 'Revert failed',
            description: `Workspace was not restored to ${turnId}.`,
            tone: 'danger',
          })
        })
        .finally(() => {
          setPendingTurnId(null)
          setConfirmingTurnId(null)
        })
    },
    [loadCheckpoints, sessionId, toast],
  )

  const reverting = pendingTurnId !== null

  return (
    <section aria-label="Checkpoints" className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-fg">Checkpoints</h3>
      {loadError ? <p role="alert" className="text-xs text-danger">{loadError}</p> : null}
      {!loadError && loaded && checkpoints.length === 0 ? (
        <p className="text-sm text-fg-subtle">No checkpoints captured for this session.</p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {checkpoints.map((checkpoint) => (
          <li
            key={checkpoint.gitRef}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-2 py-1.5"
          >
            <span className="font-mono text-2xs text-fg-muted">{checkpoint.turnId}</span>
            {confirmingTurnId === checkpoint.turnId ? (
              <>
                <span className="min-w-0 text-xs text-fg">
                  Are you sure? Revert workspace to this checkpoint.
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Confirm revert ${checkpoint.turnId}`}
                    disabled={reverting}
                    onClick={() => handleRevert(checkpoint.turnId)}
                  >
                    Confirm revert
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Cancel revert ${checkpoint.turnId}`}
                    disabled={reverting}
                    onClick={() => setConfirmingTurnId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Revert turn ${checkpoint.turnId}`}
                  loading={pendingTurnId === checkpoint.turnId}
                  disabled={reverting}
                  onClick={() => setConfirmingTurnId(checkpoint.turnId)}
                >
                  Revert
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {status ? (
        <p role="alert" className={`text-xs ${status.tone === 'success' ? 'text-success' : 'text-danger'}`}>
          {status.message}
        </p>
      ) : null}
    </section>
  )
}
