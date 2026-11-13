import { memo, useEffect, useState } from 'react'
import { ChevronRight, Minus, Plus, Undo2 } from 'lucide-react'
import type { GitReviewFile, GitReviewManifest, GitScope } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { cx, iconButton } from '../../lib/recipes'
import { setDragFilePath } from '../composer/drag-file'
import type { SessionClient } from '../session/session-client'
import { toolWireScope } from '../terminal/tool-session-client'
import { DiffSurface, type DiffRange } from '../diffs/DiffSurface'

const log = createLogger('ui:review')

export type FileAction = 'stage' | 'unstage' | 'discard'

/** Loaded patches by review identity, so a refresh only refetches files whose content moved. */
export class PatchCache {
  private readonly entries = new Map<string, string>()
  constructor(private readonly limit = 64) {}
  get(key: string): string | undefined {
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    return hit
  }
  set(key: string, text: string): void {
    this.entries.delete(key)
    this.entries.set(key, text)
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }
}

const DOT: Record<GitReviewFile['kind'], string> = {
  modified: 'bg-info',
  renamed: 'bg-info',
  added: 'bg-success',
  untracked: 'bg-success',
  deleted: 'bg-danger',
  conflicted: 'bg-warning',
}
const WORD: Partial<Record<GitReviewFile['kind'], string>> = {
  added: 'new',
  untracked: 'new',
  deleted: 'deleted',
  renamed: 'renamed',
  conflicted: 'conflict',
}

export interface FileSectionProps {
  rpc: SessionClient
  scope: GitScope
  manifest: GitReviewManifest
  file: GitReviewFile
  open: boolean
  first: boolean
  canStage: boolean
  canUnstage: boolean
  canDiscard: boolean
  actionsReason: string | null
  dragKey: string
  split: boolean
  wrap: boolean
  scroller: HTMLElement | null
  layoutVersion: number
  cache: PatchCache
  onToggle: (path: string) => void
  onAction: (action: FileAction, path: string) => void
  onRange?: (path: string, comparisonId: string, range: DiffRange) => void
}

/**
 * One changed file: a 32px header that toggles it, and its diff inline once
 * open. Collapsed files skip layout off screen, so long lists stay quick.
 */
export const FileSection = memo(function FileSection({
  rpc,
  scope,
  manifest,
  file,
  open,
  first,
  canStage,
  canUnstage,
  canDiscard,
  actionsReason,
  dragKey,
  split,
  wrap,
  scroller,
  layoutVersion,
  cache,
  onToggle,
  onAction,
  onRange,
}: FileSectionProps) {
  const at = file.path.lastIndexOf('/')
  const name = file.path.slice(at + 1)
  const folder = at >= 0 ? file.path.slice(0, at) : ''
  const word = WORD[file.kind] ?? (file.binary ? 'binary' : null)
  const actions = canStage || canUnstage || canDiscard
  return (
    <div
      data-path={file.path}
      className={cx(
        !first && 'border-t border-border',
        !open && '[contain-intrinsic-size:auto_33px] [content-visibility:auto]',
      )}
    >
      {/* Opaque, so a stuck header hides the lines scrolling under it; the
          hover wash sits on the row inside. */}
      <div className={cx('bg-bg', open && 'sticky top-0 z-10')}>
        <div className="group flex h-8 items-center pr-1.5 transition-colors hover:bg-fg/5 focus-within:bg-fg/5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={file.path}
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            draggable
            onDragStart={(event) => setDragFilePath(event, file.path, dragKey)}
            onClick={() => onToggle(file.path)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
          >
            <ChevronRight
              size={14}
              aria-hidden
              className={cx('shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')}
            />
            <span className={cx('size-1.5 shrink-0 rounded-full', DOT[file.kind])} aria-hidden />
            <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden pl-0.5">
              <span className="shrink-0 whitespace-nowrap text-fg">{name}</span>
              {folder ? <span className="min-w-0 truncate text-fg-subtle">{folder}</span> : null}
            </span>
            {word ? <span className="shrink-0 pl-2 text-[11px] text-fg-subtle">{word}</span> : null}
            {file.additions || file.deletions ? (
              <span
                className={cx(
                  'flex shrink-0 gap-1.5 pl-2 pr-1 font-mono text-[11px] tabular-nums',
                  actions && 'group-focus-within:hidden group-hover:hidden',
                )}
              >
                {file.additions ? <span className="text-success">+{file.additions}</span> : null}
                {file.deletions ? <span className="text-danger">−{file.deletions}</span> : null}
              </span>
            ) : null}
          </button>
          {actions ? (
            <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
              {canStage ? (
                <button
                  type="button"
                  aria-label={`Stage ${file.path}`}
                  title={actionsReason ?? 'Stage'}
                  disabled={actionsReason !== null}
                  onClick={() => onAction('stage', file.path)}
                  className={iconButton}
                >
                  <Plus size={14} aria-hidden />
                </button>
              ) : null}
              {canUnstage ? (
                <button
                  type="button"
                  aria-label={`Unstage ${file.path}`}
                  title={actionsReason ?? 'Unstage'}
                  disabled={actionsReason !== null}
                  onClick={() => onAction('unstage', file.path)}
                  className={iconButton}
                >
                  <Minus size={14} aria-hidden />
                </button>
              ) : null}
              {canDiscard ? (
                <button
                  type="button"
                  aria-label={`Discard changes in ${file.path}`}
                  title={actionsReason ?? 'Discard changes'}
                  disabled={actionsReason !== null}
                  onClick={() => onAction('discard', file.path)}
                  className={cx(iconButton, 'hover:text-danger')}
                >
                  <Undo2 size={14} aria-hidden />
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      {open ? (
        <FilePatch
          rpc={rpc}
          scope={scope}
          manifest={manifest}
          file={file}
          split={split}
          wrap={wrap}
          scroller={scroller}
          layoutVersion={layoutVersion}
          cache={cache}
          onRange={onRange}
        />
      ) : null}
    </div>
  )
})

/** A file's patch, read when it opens and cancelled if it closes first. */
function FilePatch({
  rpc,
  scope,
  manifest,
  file,
  split,
  wrap,
  scroller,
  layoutVersion,
  cache,
  onRange,
}: Pick<
  FileSectionProps,
  | 'rpc'
  | 'scope'
  | 'manifest'
  | 'file'
  | 'split'
  | 'wrap'
  | 'scroller'
  | 'layoutVersion'
  | 'cache'
  | 'onRange'
>) {
  // Unchanged content under the same review scope reads the same patch, so a
  // refresh does not refetch files that did not move.
  const identity =
    manifest.reviewScopeId && file.contentId
      ? `${manifest.reviewScopeId}:${file.contentId}`
      : manifest.id
  const key = `${rpc.viewKey}:${rpc.authorizationEpoch}:${identity}:${file.path}`
  const [patch, setPatch] = useState<{ key: string; text: string; error: string | null } | null>(
    () => {
      const hit = cache.get(key)
      return hit === undefined ? null : { key, text: hit, error: null }
    },
  )
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const hit = cache.get(key)
    if (hit !== undefined) {
      setPatch({ key, text: hit, error: null })
      return
    }
    let settled = false
    const requestId = crypto.randomUUID()
    void rpc
      .invoke('scm.diff', {
        ...toolWireScope(rpc, scope),
        snapshotId: manifest.id,
        path: file.path,
        context: 3,
        requestId,
      })
      .then((result) => {
        if (settled) return
        settled = true
        if (result.ok) cache.set(key, result.value)
        setPatch({
          key,
          text: result.ok ? result.value : '',
          error: result.ok ? null : result.error.message,
        })
      })
      .catch((error: unknown) => {
        if (settled) return
        settled = true
        log.warn('File diff failed', { error: String(error) })
        setPatch({ key, text: '', error: 'Could not load this file.' })
      })
    return () => {
      if (settled) return
      settled = true
      void rpc
        .invoke('scm.cancel', { requestId })
        .catch((error: unknown) => log.warn('Diff cancellation failed', { error: String(error) }))
    }
  }, [key, retry, rpc, rpc.availability])
  if (patch?.error && patch.key === key)
    return (
      <p role="alert" className="flex items-center gap-3 px-3 py-2 text-[12.5px] text-danger">
        {patch.error}
        <button
          type="button"
          className="text-fg-muted underline hover:text-fg"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry
        </button>
      </p>
    )
  // While a moved file reloads, its previous patch stays up rather than flashing.
  if (!patch || patch.error)
    return (
      <div role="status" aria-label={`Loading ${file.path}`} className="space-y-2 px-3 py-2.5">
        {[64, 82, 48].map((width) => (
          <div key={width} className="flex gap-3">
            <span className="h-2 w-6 animate-pulse rounded bg-fg/6" />
            <span className="h-2 animate-pulse rounded bg-fg/6" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    )
  return (
    <DiffSurface
      diffText={patch.text}
      path={file.path}
      comparisonId={manifest.id}
      onRange={onRange ? (range) => onRange(file.path, manifest.id, range) : undefined}
      inline={{ scrollElement: scroller, split, wrap, layoutVersion }}
    />
  )
}
