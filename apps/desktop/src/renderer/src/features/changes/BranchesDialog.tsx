import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive } from 'lucide-react'
import type { GitMutation, GitScope, SourceControlContext } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Select } from '@ari/ui/select'
import { useToast } from '@ari/ui/toast'
import { cx, sectionLabel } from '../../lib/recipes'
import { toolWireScope, useToolSessionClient } from '../terminal/tool-session-client'
import { describeMutation, useGitMutations } from './ReviewActions'

/** Text field in the input style: hairline on a raised surface. */
const field =
  'rounded-md border border-border bg-surface-1 text-[13px] text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50'

const DONE: Partial<Record<GitMutation['kind'], string>> = {
  branch: 'Branch switched',
  stash: 'Changes stashed',
  'apply-stash': 'Stash applied',
}

/**
 * Switch or create a branch, stash local changes, apply a stash. Opened from
 * the titlebar Git menu; every action runs against a fresh working-tree read.
 */
export function BranchesDialog({
  scope,
  onClose,
  refresh,
}: {
  scope: GitScope
  onClose: () => void
  refresh: () => void
}) {
  const rpc = useToolSessionClient(scope.sessionId)
  const { toast } = useToast()
  const [state, setState] = useState<{ context: SourceControlContext; snapshot: string } | null>(
    null,
  )
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [name, setName] = useState('')
  const [pending, setPending] = useState<GitMutation | null>(null)
  useEffect(() => {
    let live = true
    const wireScope = toolWireScope(rpc, scope)
    void Promise.all([
      rpc.invoke('scm.status', wireScope),
      rpc.invoke('scm.review', { ...wireScope, comparison: { kind: 'working-tree' } }),
    ])
      .then(([context, review]) => {
        if (!live) return
        if (context.ok && review.ok) {
          setState({ context: context.value, snapshot: review.value.id })
          setLoadError(null)
        } else
          setLoadError(
            !context.ok ? context.error.message : !review.ok ? review.error.message : null,
          )
      })
      .catch(() => live && setLoadError('Could not read this repository.'))
    return () => {
      live = false
    }
  }, [JSON.stringify(scope), rpc, version])
  const mutations = useGitMutations(
    scope,
    () => {
      setVersion((value) => value + 1)
      refresh()
    },
    {
      confirm: false,
      onDone: (action) => {
        if (action.kind === 'branch' && action.create) setName('')
        toast({
          title:
            action.kind === 'branch' && action.create
              ? `Created ${action.name}`
              : (DONE[action.kind] ?? 'Done'),
          tone: 'success',
        })
      },
    },
  )
  const context = state?.context ?? null
  const snapshot = state?.snapshot ?? null
  const branch = context?.status.branch ?? null
  // The ref list is capped, so the current branch may be missing from it.
  const local = [
    ...(branch && !context?.refs.includes(branch) ? [branch] : []),
    ...(context?.refs ?? []).filter(
      (ref) => !context?.status.remotes?.some((remote) => ref.startsWith(`${remote.name}/`)),
    ),
  ]
  const disabled = mutations.unavailableReason !== null || mutations.busy || !snapshot
  // Stable, so typing (which re-renders) does not send focus back to the top.
  const close = useRef(onClose)
  close.current = onClose
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) close.current()
  }, [])
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>Branches and stashes</Dialog.Title>
        <Dialog.Description>
          {context ? (
            <>
              On <span className="font-mono text-fg">{branch ?? 'detached HEAD'}</span>.
            </>
          ) : loadError ? (
            'The repository could not be read.'
          ) : (
            'Reading the repository…'
          )}
        </Dialog.Description>
        {mutations.unavailableReason ? (
          <p role="status" className="mt-3 text-[13px] text-fg-muted">
            {mutations.unavailableReason}
          </p>
        ) : null}
        <div className="mt-4 space-y-4">
          <div>
            <p className={cx(sectionLabel, 'mb-1.5')}>Switch branch</p>
            <Select
              aria-label="Switch branch"
              value={branch ?? ''}
              disabled={disabled || !local.length}
              options={local.map((ref) => ({ value: ref, label: ref }))}
              onValueChange={(next) =>
                snapshot &&
                next !== branch &&
                setPending({
                  kind: 'branch',
                  snapshotId: snapshot,
                  name: next,
                  create: false,
                  confirmed: true,
                })
              }
              className="w-full"
            />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (snapshot && name.trim())
                mutations.request({
                  kind: 'branch',
                  snapshotId: snapshot,
                  name: name.trim(),
                  create: true,
                  confirmed: true,
                })
            }}
          >
            <p className={cx(sectionLabel, 'mb-1.5')}>New branch</p>
            <div className="flex gap-2">
              <input
                aria-label="New branch name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="feature/my-change"
                maxLength={240}
                disabled={disabled}
                className={cx(field, 'h-8 min-w-0 flex-1 px-2.5')}
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={disabled || !name.trim()}
              >
                Create
              </Button>
            </div>
          </form>
          <div>
            <p className={cx(sectionLabel, 'mb-1.5')}>Stashes</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || !context?.status.files.length}
              onClick={() =>
                snapshot &&
                setPending({ kind: 'stash', snapshotId: snapshot, message: '', confirmed: true })
              }
            >
              <Archive size={14} aria-hidden />
              Stash changes
            </Button>
            {context?.stashes.length ? (
              <ul className="ari-scroll mt-1 max-h-40 overflow-auto">
                {context.stashes.map((stash) => (
                  <li key={stash.oid}>
                    <button
                      type="button"
                      disabled={disabled}
                      title={stash.subject}
                      onClick={() =>
                        snapshot &&
                        setPending({
                          kind: 'apply-stash',
                          snapshotId: snapshot,
                          oid: stash.oid,
                          confirmed: true,
                        })
                      }
                      className="block h-8 w-full truncate rounded-md px-2.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
                    >
                      Apply · {stash.subject}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        {pending ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface-0 px-3 py-2">
            <p className="min-w-0 flex-1 text-[13px] text-fg">
              {describeMutation(pending, branch)}
            </p>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={disabled}
              onClick={() => {
                const action = pending
                setPending(null)
                mutations.request(action)
              }}
            >
              Continue
            </Button>
          </div>
        ) : null}
        {(loadError ?? mutations.error) ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {loadError ?? mutations.error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
