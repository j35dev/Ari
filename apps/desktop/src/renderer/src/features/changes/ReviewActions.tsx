import { useCallback, useState, type ReactNode } from 'react'
import type { GitMutation, GitScope } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { toolWireScope, useToolSessionClient } from '../terminal/tool-session-client'

export interface GitMutations {
  /** Runs the mutation, or asks first when it throws work away. */
  request: (action: GitMutation) => void
  busy: boolean
  /** The last failure, until dismissed or the next mutation. */
  error: string | null
  dismiss: () => void
  /** Why mutations are off here (remote or read-only host); null when they are on. */
  unavailableReason: string | null
  /** The confirmation dialog; render it once wherever the hook is used. */
  dialog: ReactNode
}

export const MUTATION_TITLE: Partial<Record<GitMutation['kind'], string>> = {
  discard: 'Discard changes',
  branch: 'Switch branch',
  stash: 'Stash changes',
  'apply-stash': 'Apply stash',
}

/** The sentence a confirmation asks before a mutation runs. */
export function describeMutation(action: GitMutation, branch: string | null): string {
  switch (action.kind) {
    case 'discard':
      return action.paths.length === 1
        ? `Discard working changes in ${action.paths[0]}? Ari creates a recovery checkpoint first.`
        : `Discard working changes in ${action.paths.length} files? Ari creates a recovery checkpoint first.`
    case 'branch':
      return `Switch to ${action.name}? Commit or stash local changes first.`
    case 'apply-stash':
      return 'Restore these saved changes into this worktree? The stash is kept.'
    case 'stash':
      return 'Save all local changes, including untracked files, in a stash?'
    default:
      return `Change ${branch ?? 'this branch'}?`
  }
}

/** Mutations that throw work away or move the worktree wait for a yes. */
const confirms = (action: GitMutation): boolean =>
  action.kind === 'discard' ||
  action.kind === 'branch' ||
  action.kind === 'stash' ||
  action.kind === 'apply-stash'

/**
 * Local Git mutations against the snapshot being reviewed: stage, unstage and
 * discard from a file row, branches and stashes from the Git menu. Every call
 * refreshes the review afterwards, whether it worked or not.
 */
export function useGitMutations(
  scope: GitScope,
  refresh: () => void,
  options: {
    branch?: string | null
    onDone?: (action: GitMutation) => void
    /** False when the caller has already asked. */
    confirm?: boolean
  } = {},
): GitMutations {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = toolWireScope(rpc, scope)
  const unavailableReason =
    rpc.scope.kind === 'remote'
      ? 'Git changes must be made on the owning machine. These controls are unavailable remotely.'
      : rpc.readOnly
        ? 'Reconnect to the owning machine to change files.'
        : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<GitMutation | null>(null)
  const run = async (action: GitMutation): Promise<void> => {
    if (unavailableReason || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await rpc.invoke('scm.mutate', { ...wireScope, action })
      if (result.ok) options.onDone?.(action)
      else setError(result.error.message)
    } catch {
      setError('The result could not be confirmed. Refresh before retrying.')
    } finally {
      setBusy(false)
      refresh()
    }
  }
  // Stable, so re-rendering the review under an open dialog keeps its focus.
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) setConfirm(null)
  }, [])
  const dialog = (
    <Dialog open={confirm !== null} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{(confirm && MUTATION_TITLE[confirm.kind]) ?? 'Change files'}</Dialog.Title>
        <Dialog.Description>
          {confirm ? describeMutation(confirm, options.branch ?? null) : null}
        </Dialog.Description>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={confirm?.kind === 'discard' ? 'danger' : 'primary'}
            onClick={() => {
              const action = confirm
              setConfirm(null)
              if (action) void run(action)
            }}
          >
            {confirm?.kind === 'discard' ? 'Discard' : 'Continue'}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
  return {
    request: (action) => {
      if (unavailableReason || busy) return
      if (options.confirm !== false && confirms(action)) setConfirm(action)
      else void run(action)
    },
    busy,
    error,
    dismiss: () => setError(null),
    unavailableReason,
    dialog,
  }
}
