import { useState } from 'react'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Select } from '@ari/ui/select'
import type { GitMutation } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import type { ReviewControlsState } from './ReviewWorkspace'

const log = createLogger('ui:git-actions')

/** Explicit, independently retryable Git actions tied to the snapshot the user reviewed. */
export function GitActions({
  scope,
  context,
  manifest,
  paths,
  loading,
  refresh,
  onCreatePr,
}: ReviewControlsState & { onCreatePr?: () => void }) {
  const [message, setMessage] = useState('')
  const [remote, setRemote] = useState('origin')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<GitMutation | null>(null)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const status = context?.status
  const mutable =
    manifest && ['working-tree', 'staged', 'unstaged'].includes(manifest.comparison.kind)
  const enabled = !!mutable && !loading && !busy && !status?.operation
  const selected = status?.files.filter((file) => paths.includes(file.path)) ?? []
  const currentRemote = status?.remotes.some((item) => item.name === remote)
    ? remote
    : status?.remotes[0]?.name
  const run = async (action: GitMutation): Promise<void> => {
    if (busy) return
    setBusy(true)
    setPending(null)
    setNotice(null)
    try {
      const result = await rpc.invoke('scm.mutate', { ...scope, action })
      setNotice({
        error: !result.ok,
        text: result.ok
          ? `${result.value.message}${result.value.recoveryRef ? ` Recovery snapshot: ${result.value.recoveryRef}` : ''}`
          : `${action.kind === 'push' ? 'Push failed; local commits are unchanged. ' : ''}${result.error.message}`,
      })
      if (result.ok && action.kind === 'commit') setMessage('')
    } catch (error) {
      log.warn('Git action failed', { error: String(error) })
      setNotice({
        error: true,
        text: 'The action could not be confirmed. Refresh repository state before retrying.',
      })
    } finally {
      setBusy(false)
      refresh()
    }
  }
  const request = (action: GitMutation): void => {
    if ('confirmed' in action) setPending(action)
    else void run(action)
  }
  const id = manifest?.id
  const stale = pending && pending.snapshotId !== id
  const stagedView = manifest?.comparison.kind === 'staged'
  const unstagedView = manifest?.comparison.kind === 'unstaged'
  return (
    <section className="shrink-0 border-t border-border bg-surface-0 p-3" aria-label="Git actions">
      <div className="mb-2 flex items-center gap-2 text-2xs text-fg-subtle">
        <span title={paths.join('\n')}>
          {paths.length} selected · Ctrl/Cmd-click files to select more
        </span>
        <span className="ml-auto font-mono">
          ↑{status?.ahead ?? 0} ↓{status?.behind ?? 0}
        </span>
      </div>
      {status?.operation ? (
        <p role="alert" className="mb-2 text-xs text-warning">
          Finish the active {status.operation} before changing Git state.
        </p>
      ) : !mutable ? (
        <p className="mb-2 text-xs text-fg-muted">
          Choose Working tree, Staged or Unstaged to change local Git state.
        </p>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!enabled || stagedView || !selected.some((file) => file.unstaged)}
          onClick={() => id && request({ kind: 'stage', paths, snapshotId: id })}
        >
          Stage selected
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled || unstagedView || !selected.some((file) => file.staged)}
          onClick={() => id && request({ kind: 'unstage', paths, snapshotId: id })}
        >
          Unstage selected
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled || stagedView || !selected.some((file) => file.unstaged)}
          onClick={() => id && request({ kind: 'discard', paths, snapshotId: id, confirmed: true })}
        >
          Discard selected
        </Button>
      </div>
      <div className="mb-2 flex items-center gap-2">
        <input
          aria-label="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={8000}
          placeholder="Commit message — staged changes only"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-xs text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-ring"
        />
        <Button
          size="sm"
          disabled={
            !enabled ||
            unstagedView ||
            !message.trim() ||
            !status?.files.some((file) => file.staged)
          }
          onClick={() => id && request({ kind: 'commit', message: message.trim(), snapshotId: id })}
        >
          Commit
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Git remote"
          value={currentRemote ?? ''}
          options={(status?.remotes ?? []).map((remote) => ({
            value: remote.name,
            label: remote.name,
          }))}
          onValueChange={setRemote}
          className="max-w-32"
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled || !currentRemote}
          onClick={() =>
            id && currentRemote && request({ kind: 'fetch', remote: currentRemote, snapshotId: id })
          }
        >
          Fetch
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!enabled || !status?.upstream || !!status.files.length}
          onClick={() => id && request({ kind: 'pull', snapshotId: id, confirmed: true })}
        >
          Pull
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!enabled || !currentRemote || !status?.branch}
          onClick={() =>
            id &&
            currentRemote &&
            request({ kind: 'push', remote: currentRemote, snapshotId: id, confirmed: true })
          }
        >
          Push
        </Button>
        {onCreatePr ? (
          <Button size="sm" variant="ghost" disabled={!status?.branch || busy} onClick={onCreatePr}>
            Create PR
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={`mt-2 break-words text-xs ${notice.error ? 'text-danger' : 'text-fg-muted'}`}
        >
          {notice.text}
        </p>
      ) : null}
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      >
        <Dialog.Content>
          <Dialog.Title>Confirm {pending?.kind}</Dialog.Title>
          <Dialog.Description>
            {pending?.kind === 'discard'
              ? 'Discard unstaged changes in these files? Existing staging is preserved and a recovery snapshot is saved first.'
              : `${pending?.kind ?? 'Git action'} on ${status?.branch ?? 'detached HEAD'}${pending?.kind === 'push' ? ` to ${pending.remote}` : ''}? This changes ${pending?.kind === 'push' ? 'the remote repository' : 'local Git state'}.`}
          </Dialog.Description>
          {pending && 'paths' in pending ? (
            <pre className="my-3 max-h-40 overflow-auto font-mono text-xs text-fg-muted">
              {pending.paths.join('\n')}
            </pre>
          ) : null}
          {pending?.kind === 'push' && ['main', 'master'].includes(status?.branch ?? '') ? (
            <p className="mt-3 text-xs text-warning">
              You are publishing directly to a default branch.
            </p>
          ) : null}
          {stale ? (
            <p role="alert" className="mt-3 text-xs text-danger">
              The reviewed state changed. Cancel, refresh and review again.
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!!stale || busy}
              onClick={() => pending && void run(pending)}
            >
              Confirm {pending?.kind}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </section>
  )
}
