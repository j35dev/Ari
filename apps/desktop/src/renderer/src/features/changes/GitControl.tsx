import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  GitPullRequestArrow,
} from 'lucide-react'
import type {
  GitPullRequest as PullRequest,
  GitReviewFile,
  GitScope,
  GitShipAction,
  GitShipOutcome,
  GitSummary,
} from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Popover } from '@ari/ui/popover'
import { useToast } from '@ari/ui/toast'
import { createLogger } from '@ari/shared/logger'
import { rpc as localRpc } from '../../lib/rpc'
import { toolWireScope, useToolSessionClient } from '../terminal/tool-session-client'
import { menuActions, pushesToDefault, quickAction, type MenuAction } from './git-quick-action'
import { useEngineSettings } from '../settings/useEngineSettings'
import { branchLabel } from '../session/branch-label'

const log = createLogger('ui:git-control')
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

const PROGRESS: Record<GitShipAction, string> = {
  commit: 'Committing…',
  commit_push: 'Committing and pushing…',
  commit_push_pr: 'Committing, pushing and opening a pull request…',
  push: 'Pushing…',
  push_pr: 'Pushing and opening a pull request…',
  pull: 'Pulling…',
  create_pr: 'Opening a pull request…',
  fetch: 'Fetching…',
}

function doneTitle(outcome: GitShipOutcome): string {
  const parts = [
    outcome.committed ? 'Committed' : null,
    outcome.pushed ? 'pushed' : null,
    outcome.pulled ? 'Pulled' : null,
    outcome.prUrl ? 'pull request opened' : null,
  ].filter(Boolean)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const openUrl = (url: string): void => {
  void localRpc.invoke('shell.openUrl', { url }).catch((error: unknown) => {
    log.warn('could not open link', { error: String(error) })
  })
}

/** The open PR for the current branch, re-read when the branch or revision moves. */
function usePullRequest(scope: GitScope, branch: string | null, revision: number) {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = toolWireScope(rpc, scope)
  const [pr, setPr] = useState<PullRequest | null>(null)
  const key = JSON.stringify(scope)
  useEffect(() => {
    let live = true
    if (!branch || rpc.scope.kind === 'remote' || rpc.readOnly) {
      setPr(null)
      return
    }
    void rpc
      .invoke('scm.pullRequest', { ...wireScope, ...(revision > 0 ? { refresh: true } : {}) })
      .then((result) => {
        if (live) setPr(result.ok ? result.value : null)
      })
      .catch(() => {
        if (live) setPr(null)
      })
    return () => {
      live = false
    }
  }, [key, branch, revision, rpc, rpc.authorizationEpoch, rpc.availability])
  return pr
}

/**
 * The titlebar's single Git entry point: one primary action chosen from branch
 * state (commit, push, pull, open or view a PR) with the individual steps and
 * the review views in its menu.
 */
export function GitControl({
  scope,
  summary,
  refresh,
  onReview,
  onPullRequests,
}: {
  scope: GitScope
  summary: GitSummary
  refresh: () => void
  onReview: () => void
  onPullRequests: () => void
}) {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = toolWireScope(rpc, scope)
  const unavailableReason =
    rpc.scope.kind === 'remote'
      ? 'Git actions must be performed on the owning machine.'
      : rpc.readOnly
        ? 'Reconnect to the owning machine to use Git actions.'
        : null
  const { toast, update } = useToast()
  const [revision, setRevision] = useState(0)
  const pr = usePullRequest(scope, summary.branch, revision)
  const primary = quickAction(summary, pr)
  const items = menuActions(summary, pr)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commit, setCommit] = useState<GitShipAction | null>(null)
  const [confirm, setConfirm] = useState<{
    action: GitShipAction
    message?: string
    paths?: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const { settings } = useEngineSettings()
  const confirmDefault = settings?.sourceControl.confirmDefaultPush ?? true
  const fetchSeconds = settings?.sourceControl.fetchIntervalSeconds ?? 60
  const scopeKey = JSON.stringify(scope)

  // Background fetch keeps ahead/behind current so Pull shows up when someone else pushed.
  useEffect(() => {
    if (unavailableReason || fetchSeconds <= 0 || !summary.hasRemote) return
    const timer = setInterval(() => {
      if (document.hidden) return
      void rpc
        .invoke('scm.ship', { ...wireScope, action: 'fetch' })
        .then((result) => {
          if (result.ok) refresh()
        })
        .catch((error: unknown) => log.debug('background fetch failed', { error: String(error) }))
    }, fetchSeconds * 1000)
    return () => clearInterval(timer)
  }, [scopeKey, fetchSeconds, summary.hasRemote, unavailableReason, rpc])

  const run = async (action: GitShipAction, message?: string, paths?: string[]): Promise<void> => {
    if (unavailableReason || busy) return
    setBusy(true)
    const id = toast({ title: PROGRESS[action], tone: 'info', durationMs: 0 })
    try {
      const result = await rpc.invoke('scm.ship', {
        ...wireScope,
        action,
        ...(message ? { message } : {}),
        ...(paths ? { paths } : {}),
      })
      if (result.ok) {
        const prUrl = result.value.prUrl
        update(id, {
          title: doneTitle(result.value),
          ...(result.value.committed ? { description: result.value.committed } : {}),
          tone: 'success',
          durationMs: 5000,
          ...(prUrl ? { action: { label: 'View PR', onClick: () => openUrl(prUrl) } } : {}),
        })
      } else {
        update(id, {
          title: 'Git action failed',
          description: result.error.message,
          tone: 'danger',
          durationMs: 10_000,
        })
      }
    } catch (error) {
      log.warn('ship failed', { error: String(error) })
      update(id, {
        title: 'Git action failed',
        description: 'The result could not be confirmed. Check the repository before retrying.',
        tone: 'danger',
        durationMs: 10_000,
      })
    } finally {
      setBusy(false)
      setRevision((value) => value + 1)
      refresh()
    }
  }

  /** Commits go through the dialog; pushes to a default branch ask first. */
  const start = (action: GitShipAction, message?: string, paths?: string[]): void => {
    if (unavailableReason) return
    if (confirmDefault && pushesToDefault(summary, action))
      setConfirm({ action, ...(message ? { message } : {}), ...(paths ? { paths } : {}) })
    else void run(action, message, paths)
  }

  const onPrimary = (): void => {
    if (unavailableReason) return
    if (primary.kind === 'view-pr') openUrl(primary.url)
    else if (primary.kind === 'ship') {
      if (primary.commits) setCommit(primary.action)
      else start(primary.action)
    }
  }

  const onItem = (item: MenuAction): void => {
    if (unavailableReason) return
    setMenuOpen(false)
    if (item.id === 'commit') setCommit('commit')
    else if (item.id === 'push') start('push')
    else if (item.id === 'pull') start('pull')
    else if (pr?.state === 'open') openUrl(pr.url)
    else start('create_pr')
  }

  const Icon =
    primary.kind === 'view-pr'
      ? GitPullRequest
      : primary.kind === 'ship' && primary.action === 'pull'
        ? ArrowDown
        : primary.kind === 'ship' && !primary.commits
          ? primary.action === 'create_pr'
            ? GitPullRequestArrow
            : ArrowUp
          : GitCommitHorizontal
  const disabled = unavailableReason !== null || primary.kind === 'disabled' || busy

  return (
    <div className="flex items-center" style={noDrag}>
      <div
        className="flex h-7 items-center gap-0.5 text-[13px] text-fg"
        title={unavailableReason ?? (primary.kind === 'disabled' ? primary.reason : undefined)}
      >
        {/* The branch the workspace is on; it used to take a row of its own
            above the transcript. */}
        <span
          className="hidden max-w-44 items-center gap-1.5 px-2 text-fg-subtle @[68rem]:flex"
          title={summary.branch ?? 'Detached HEAD'}
          data-testid="git-branch"
        >
          <GitBranch size={14} strokeWidth={1.7} aria-hidden className="shrink-0" />
          <span className="truncate">
            {summary.branch ? branchLabel(summary.branch) : 'detached'}
          </span>
        </span>
        <button
          type="button"
          onClick={onPrimary}
          disabled={disabled}
          aria-label={primary.label}
          title={primary.label}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium transition-colors hover:bg-fg/6 disabled:pointer-events-none disabled:font-normal disabled:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <Icon size={14} strokeWidth={1.7} aria-hidden className="text-fg-subtle" />
          <span className="hidden whitespace-nowrap @[58rem]:inline">
            {busy ? 'Working…' : primary.label}
          </span>
        </button>
        <Popover
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open)
            if (open) {
              refresh()
              setRevision((value) => value + 1)
            }
          }}
        >
          <Popover.Trigger
            aria-label="Git actions"
            aria-haspopup="menu"
            className="flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <ChevronDown size={12} aria-hidden />
          </Popover.Trigger>
          <Popover.Content side="bottom" align="end" sideOffset={6} bare>
            <div
              role="menu"
              className="w-64 rounded-xl border border-border-strong bg-surface-1 p-1 text-[13px] shadow-3"
            >
              <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1.5 text-xs text-fg-subtle">
                <GitBranch size={11} aria-hidden />
                <span className="truncate font-mono">{summary.branch ?? 'detached HEAD'}</span>
                <span className="ml-auto font-mono tabular-nums">
                  {summary.ahead > 0 ? `↑${summary.ahead} ` : ''}
                  {summary.behind > 0 ? `↓${summary.behind}` : ''}
                </span>
              </div>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={unavailableReason !== null || item.reason !== null || busy}
                  title={unavailableReason ?? item.reason ?? undefined}
                  onClick={() => onItem(item)}
                  className="flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-fg/6 disabled:pointer-events-none"
                >
                  <span className={item.reason ? 'text-fg-subtle' : 'text-fg'}>{item.label}</span>
                  {item.reason ? (
                    <span className="text-xs text-fg-subtle">{item.reason}</span>
                  ) : null}
                </button>
              ))}
              <div className="mx-1 my-1 h-px bg-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onReview()
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-fg transition-colors hover:bg-fg/6"
              >
                <FileDiff size={14} aria-hidden className="text-fg-subtle" />
                Review changes
                {summary.changedFiles > 0 ? (
                  <span className="ml-auto text-xs tabular-nums text-fg-subtle">
                    {summary.changedFiles}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={unavailableReason !== null}
                title={unavailableReason ?? undefined}
                onClick={() => {
                  setMenuOpen(false)
                  onPullRequests()
                }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-fg transition-colors hover:bg-fg/6"
              >
                <GitPullRequest size={14} aria-hidden className="text-fg-subtle" />
                Pull requests
              </button>
            </div>
          </Popover.Content>
        </Popover>
      </div>
      {commit !== null ? (
        <CommitDialog
          scope={scope}
          summary={summary}
          action={commit}
          onClose={() => setCommit(null)}
          onCommit={(message, paths) => {
            setCommit(null)
            start(commit, message, paths)
          }}
        />
      ) : null}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <Dialog.Content>
          <Dialog.Title>Push to {summary.branch}?</Dialog.Title>
          <Dialog.Description>
            This publishes straight to the default branch, without a pull request.
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const pending = confirm
                setConfirm(null)
                if (pending) void run(pending.action, pending.message, pending.paths)
              }}
            >
              Push to {summary.branch}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

const SUBMIT: Partial<Record<GitShipAction, string>> = {
  commit: 'Commit',
  commit_push: 'Commit & push',
  commit_push_pr: 'Commit, push & PR',
}

/** Files to include and an optional message; blank describes the files. */
function CommitDialog({
  scope,
  summary,
  action,
  onClose,
  onCommit,
}: {
  scope: GitScope
  summary: GitSummary
  action: GitShipAction
  onClose: () => void
  onCommit: (message: string | undefined, paths: string[] | undefined) => void
}) {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = toolWireScope(rpc, scope)
  const [files, setFiles] = useState<GitReviewFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  useEffect(() => {
    let live = true
    void rpc
      .invoke('scm.review', { ...wireScope, comparison: { kind: 'working-tree' } })
      .then((result) => {
        if (!live) return
        if (result.ok) setFiles(result.value.files)
        else setError(result.error.message)
      })
      .catch(() => live && setError('Could not read the changed files.'))
    return () => {
      live = false
    }
  }, [JSON.stringify(scope), rpc])
  const included = useMemo(
    () => (files ?? []).filter((file) => !excluded.has(file.path)),
    [files, excluded],
  )
  const totals = included.reduce(
    (sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }),
    { add: 0, del: 0 },
  )
  const toggle = (path: string): void =>
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const submit = (): void => {
    if (rpc.scope.kind === 'remote' || rpc.readOnly || included.length === 0) return
    onCommit(
      message.trim() || undefined,
      excluded.size > 0 ? included.map((file) => file.path) : undefined,
    )
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content>
        <Dialog.Title>Commit changes</Dialog.Title>
        <Dialog.Description>
          On <span className="font-mono text-fg">{summary.branch ?? 'detached HEAD'}</span>. Leave
          the message blank to describe the files.
        </Dialog.Description>
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface-0">
          <div className="ari-scroll max-h-52 overflow-auto py-1">
            {files === null && !error ? (
              <p className="px-3 py-2 text-xs text-fg-subtle">Reading changes…</p>
            ) : error ? (
              <p role="alert" className="px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : (
              files!.map((file) => {
                const on = !excluded.has(file.path)
                return (
                  <label
                    key={file.path}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-xs hover:bg-fg/5"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(file.path)}
                      className="size-3.5 accent-[var(--ari-accent)]"
                    />
                    <span
                      className={`min-w-0 flex-1 truncate ${on ? 'text-fg' : 'text-fg-subtle line-through'}`}
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    <span className="shrink-0 tabular-nums text-success">+{file.additions}</span>
                    <span className="shrink-0 tabular-nums text-danger">−{file.deletions}</span>
                  </label>
                )
              })
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-xs text-fg-subtle">
            <span>
              {included.length} of {files?.length ?? 0} files
            </span>
            <span className="font-mono tabular-nums">
              <span className="text-success">+{totals.add}</span>{' '}
              <span className="text-danger">−{totals.del}</span>
            </span>
          </div>
        </div>
        <textarea
          aria-label="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
          }}
          rows={3}
          maxLength={8000}
          placeholder="Commit message (optional)"
          className="mt-3 w-full resize-none rounded-md border border-border bg-surface-0 px-3 py-2 text-[13px] text-fg placeholder:text-fg-subtle hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={included.length === 0} onClick={submit}>
            {SUBMIT[action] ?? 'Commit'}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
