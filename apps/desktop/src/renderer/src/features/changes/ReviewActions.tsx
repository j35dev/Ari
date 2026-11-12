import { useState } from 'react'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react'
import type { GitMutation } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Popover } from '@ari/ui/popover'
import { Select } from '@ari/ui/select'
import { cx, iconButton, iconButtonActive, sectionLabel } from '../../lib/recipes'
import { toolWireScope, useToolSessionClient } from '../terminal/tool-session-client'
import type { ReviewControlsState } from './ReviewWorkspace'

/** Text field in the input style: hairline on a raised surface. */
const field =
  'rounded-md border border-border bg-surface-1 text-[13px] text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50'

/** An icon action that throws work away: quiet until hovered, then danger. */
const destructiveIcon =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fg/6 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-40'

/** Every local mutation uses the snapshot currently being reviewed. */
export function ReviewActions({
  scope,
  context,
  manifest,
  paths,
  loading,
  refresh,
}: ReviewControlsState) {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = toolWireScope(rpc, scope)
  const unavailableReason = rpc.scope.kind === 'remote'
    ? 'Git changes must be made on the owning machine. These controls are unavailable remotely.'
    : rpc.readOnly ? 'Reconnect to the owning machine to change files.' : null
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [branch, setBranch] = useState('')
  const [branchesOpen, setBranchesOpen] = useState(false)
  const [confirm, setConfirm] = useState<GitMutation | null>(null)
  const mutable =
    manifest &&
    ['working-tree', 'unstaged', 'staged'].includes(manifest.comparison?.kind ?? 'working-tree')
  const staged = context?.status.files.filter((file) => file.staged).length ?? 0
  const canStage =
    context?.status.files.some((file) => paths.includes(file.path) && file.unstaged) ?? false
  const canUnstage =
    context?.status.files.some((file) => paths.includes(file.path) && file.staged) ?? false
  const disabled = unavailableReason !== null || busy || loading || !manifest || !context || !mutable
  const run = async (action: GitMutation): Promise<void> => {
    if (unavailableReason || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await rpc.invoke('scm.mutate', { ...wireScope, action })
      setNotice(
        result.ok
          ? { text: result.value.message, error: false }
          : { text: result.error.message, error: true },
      )
      if (result.ok && action.kind === 'commit') {
        setMessage('')
        setCommitOpen(false)
      }
      if (result.ok && action.kind === 'branch') {
        setBranch('')
        setBranchesOpen(false)
      }
    } catch {
      setNotice({
        text: 'The result could not be confirmed. Refresh before retrying.',
        error: true,
      })
    } finally {
      setBusy(false)
      refresh()
    }
  }
  if (!mutable || !manifest) return null
  const remote =
    context?.status.remotes?.find((remote) => remote.name === 'origin')?.name ??
    context?.status.remotes?.[0]?.name
  const confirmDescription =
    confirm?.kind === 'discard'
      ? `Discard working changes in ${confirm.paths.length} selected file${confirm.paths.length === 1 ? '' : 's'}? Ari creates a recovery checkpoint first.`
      : confirm?.kind === 'push'
        ? `Push local commits on ${context?.status.branch ?? 'this branch'} to ${confirm.remote}?`
        : confirm?.kind === 'pull'
          ? `Fast-forward ${context?.status.branch ?? 'this branch'} from its upstream?`
          : confirm?.kind === 'branch'
            ? `Switch to ${confirm.name}? Commit or stash local changes first.`
            : confirm?.kind === 'apply-stash'
              ? 'Restore these saved changes into this worktree? The stash is kept.'
              : 'Save all local changes, including untracked files, in a stash?'
  return (
    <div className="shrink-0 border-t border-border">
      {unavailableReason ? (
        <p role="status" className="px-4 py-2 text-[13px] text-fg-muted">
          {unavailableReason}
        </p>
      ) : null}
      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={`border-b border-border px-4 py-2 text-[13px] ${notice.error ? 'text-danger' : 'text-fg-muted'}`}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !canStage || !paths.length}
          onClick={() => void run({ kind: 'stage', snapshotId: manifest.id, paths })}
        >
          <Plus size={14} />
          Stage{paths.length > 1 ? ` ${paths.length}` : ''}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !canUnstage || !paths.length}
          onClick={() => void run({ kind: 'unstage', snapshotId: manifest.id, paths })}
        >
          <Minus size={14} />
          Unstage
        </Button>
        <button
          type="button"
          aria-label="Discard selected changes"
          title="Discard selected working changes"
          disabled={disabled || !canStage || !paths.length}
          onClick={() =>
            setConfirm({ kind: 'discard', snapshotId: manifest.id, paths, confirmed: true })
          }
          className={destructiveIcon}
        >
          <Trash2 size={14} />
        </button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Popover open={branchesOpen} onOpenChange={setBranchesOpen}>
          <Popover.Trigger
            aria-label="Branches and stashes"
            disabled={disabled}
            className={cx(iconButton, branchesOpen && iconButtonActive)}
          >
            <GitBranch size={14} />
          </Popover.Trigger>
          <Popover.Content align="end" className="w-72 p-3">
            <p className={cx(sectionLabel, 'mb-2')}>Branches</p>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (branch.trim())
                  void run({
                    kind: 'branch',
                    snapshotId: manifest.id,
                    name: branch.trim(),
                    create: true,
                    confirmed: true,
                  })
              }}
              className="mb-3 flex gap-2"
            >
              <input
                aria-label="New branch name"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature/my-change"
                maxLength={240}
                className={cx(field, 'h-7 min-w-0 flex-1 px-2.5')}
              />
              <Button type="submit" size="sm" variant="secondary" disabled={busy || !branch.trim()}>
                Create
              </Button>
            </form>
            <Select
              aria-label="Switch branch"
              value={context?.status.branch ?? ''}
              options={(context?.refs ?? [])
                .filter(
                  (ref) =>
                    !context?.status.remotes?.some((remote) => ref.startsWith(`${remote.name}/`)),
                )
                .map((ref) => ({ value: ref, label: ref }))}
              onValueChange={(name) =>
                setConfirm({
                  kind: 'branch',
                  snapshotId: manifest.id,
                  name,
                  create: false,
                  confirmed: true,
                })
              }
              className="w-full"
            />
            <div className="mt-3 border-t border-border pt-3">
              <p className={cx(sectionLabel, 'mb-2')}>Stashes</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !context?.status.files.length}
                onClick={() =>
                  setConfirm({
                    kind: 'stash',
                    snapshotId: manifest.id,
                    message: '',
                    confirmed: true,
                  })
                }
              >
                <Archive size={14} />
                Stash changes
              </Button>
              {context?.stashes.map((stash) => (
                <button
                  key={stash.oid}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setConfirm({
                      kind: 'apply-stash',
                      snapshotId: manifest.id,
                      oid: stash.oid,
                      confirmed: true,
                    })
                  }
                  className="mt-1 block h-8 w-full truncate rounded-md px-2.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
                  title={stash.subject}
                >
                  Apply · {stash.subject}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Pull commits"
          disabled={disabled || !remote || !context?.status.upstream}
          title={
            context?.status.upstream
              ? `${context.status.behind} commits behind`
              : 'Publish the branch before pulling'
          }
          onClick={() => setConfirm({ kind: 'pull', snapshotId: manifest.id, confirmed: true })}
        >
          <ArrowDown size={14} />
          <span className="hidden @[44rem]:inline">Pull</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Push commits"
          disabled={disabled || !remote || !context?.status.branch}
          title={`${context?.status.ahead ?? 0} commits ahead`}
          onClick={() =>
            remote && setConfirm({ kind: 'push', snapshotId: manifest.id, remote, confirmed: true })
          }
        >
          <ArrowUp size={14} />
          <span className="hidden @[44rem]:inline">Push</span>
        </Button>
        <div className="flex-1" />
        {/* One ink action at a time: once the message form is open, its
            Commit button is the primary and this one steps back. */}
        <Button
          size="sm"
          variant={commitOpen ? 'secondary' : 'primary'}
          disabled={disabled || !staged}
          onClick={() => setCommitOpen(!commitOpen)}
        >
          <GitCommitHorizontal size={14} />
          Commit staged{staged ? ` (${staged})` : ''}
        </Button>
      </div>
      {commitOpen ? (
        <form
          className="border-t border-border px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (message.trim() && !disabled)
              void run({ kind: 'commit', snapshotId: manifest.id, message })
          }}
        >
          <textarea
            rows={2}
            aria-label="Commit staged message"
            value={message}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                message.trim() &&
                !disabled
              ) {
                event.preventDefault()
                void run({ kind: 'commit', snapshotId: manifest.id, message })
              }
            }}
            maxLength={8000}
            placeholder="Describe this commit…"
            className={cx(field, 'w-full resize-none px-3 py-2')}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-fg-subtle">
              Only staged changes are committed · Ctrl / ⌘ Enter
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={disabled || !message.trim()}
            >
              {busy ? 'Committing…' : 'Commit'}
            </Button>
          </div>
        </form>
      ) : null}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <Dialog.Content>
          <Dialog.Title>
            {confirm?.kind === 'discard'
              ? 'Discard changes'
              : confirm?.kind === 'push'
                ? 'Push commits'
                : confirm?.kind === 'pull'
                  ? 'Pull commits'
                  : confirm?.kind === 'branch'
                    ? 'Switch branch'
                    : 'Restore or save work'}
          </Dialog.Title>
          <Dialog.Description>{confirmDescription}</Dialog.Description>
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
              Continue
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}
