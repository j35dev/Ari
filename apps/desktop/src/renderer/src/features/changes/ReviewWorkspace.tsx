import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Columns2, ListTree, RefreshCw, Search, TextWrap } from 'lucide-react'
import type { GitComparison, GitScope } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { cx, iconButton, iconButtonActive } from '../../lib/recipes'
import { useSessionClient } from '../session/session-client'
import { useToolSessionClient } from '../terminal/tool-session-client'
import { useEngineSettings } from '../settings/useEngineSettings'
import type { DiffRange } from '../diffs/DiffSurface'
import { ChangedFiles } from './ChangedFiles'
import { ChangeRequests } from './ChangeRequests'
import { FileSection, PatchCache, type FileAction } from './FileStack'
import { useGitMutations } from './ReviewActions'
import { BasePicker, ScopeMenu, type ScopeTurn } from './ScopeMenu'
import { TurnRevert } from './TurnRevert'
import { useReviewPreferences } from './use-review-preferences'
import { useSourceControl } from './use-source-control'

const log = createLogger('ui:review')
export type ReviewView = 'changes' | 'requests'
export interface ReviewWorkspaceProps {
  scope: GitScope | null
  initialComparison?: GitComparison
  onRange?: (path: string, comparisonId: string, range: DiffRange) => void
  label?: 'Review changes' | 'Source control'
  /** Local review, or the host's pull requests in the same panel. */
  view?: ReviewView
  onViewChange?: (view: ReviewView) => void
  /** Why pull requests and turn reverts are off here (remote machines); null when on. */
  administrationReason?: string | null
  onCheckedOut?: (path: string) => Promise<void> | void
  /** The panel's own tools (project, expand/dock, close), at the right end of the header. */
  tools?: ReactNode
}

/** Files at or under these limits all open at once; past them only the first does. */
const OPEN_ALL_FILES = 5
const OPEN_ALL_LINES = 400
const LAYOUT_KEY = 'ari:review:layout'

interface Layout {
  split: boolean | null
  wrap: boolean | null
  tree: boolean
}
function readLayout(): Layout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return { split: null, wrap: null, tree: false }
    const value = raw as Record<string, unknown>
    const flag = (entry: unknown) => (typeof entry === 'boolean' ? entry : null)
    return { split: flag(value['split']), wrap: flag(value['wrap']), tree: value['tree'] === true }
  } catch {
    return { split: null, wrap: null, tree: false }
  }
}

/** The engine's own pick when a branch is compared without a chosen base. */
export function automaticBase(refs: readonly string[]): string {
  return (
    ['origin/main', 'origin/master', 'main', 'master'].find((ref) => refs.includes(ref)) ?? 'HEAD'
  )
}

function ago(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** When each turn started, from the session's messages; a turn's first message wins. */
function turnStarts(model: unknown): Record<string, number> {
  const messages =
    typeof model === 'object' && model !== null ? (model as { messages?: unknown }).messages : null
  const starts: Record<string, number> = {}
  if (!Array.isArray(messages)) return starts
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const { turnId, createdAt } = message as { turnId?: unknown; createdAt?: unknown }
    if (typeof turnId !== 'string' || typeof createdAt !== 'number') continue
    starts[turnId] = Math.min(starts[turnId] ?? createdAt, createdAt)
  }
  return starts
}

/**
 * Worktree-aware review: one header row picks the scope and lays out the
 * diffs, and the changed files stack below it, each opening inline.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  if (!props.scope)
    return (
      <section
        className="flex h-full min-h-0 flex-col bg-bg"
        aria-label={props.label ?? 'Review changes'}
      >
        <header className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border pl-4 pr-1.5">
          <h2 className="sr-only">{props.label ?? 'Review changes'}</h2>
          <div className="flex-1" />
          {props.tools}
        </header>
        <p className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-fg-subtle">
          Open a project or session to see its changes.
        </p>
      </section>
    )
  return <ScopedReview key={JSON.stringify(props.scope)} {...props} scope={props.scope} />
}

function ScopedReview({
  scope,
  initialComparison,
  onRange,
  label = 'Review changes',
  view = 'changes',
  onViewChange,
  administrationReason = null,
  onCheckedOut,
  tools,
}: ReviewWorkspaceProps & { scope: GitScope }) {
  const rpc = useToolSessionClient(scope.sessionId)
  const dragKey = useSessionClient().viewKey
  const remote = rpc.scope.kind === 'remote'
  const scopeKey = remote ? `${rpc.viewKey}:${JSON.stringify(scope)}` : JSON.stringify(scope)
  const preferences = useReviewPreferences(scopeKey)
  const { comparison, filter: storedFilter } = preferences.value
  const requests = view === 'requests'
  const { context, manifest, error, watchError, loading, refresh } = useSourceControl(
    scope,
    requests ? null : comparison,
  )
  useEffect(() => {
    if (initialComparison) preferences.change({ comparison: initialComparison })
  }, [JSON.stringify(initialComparison)])

  // Layout: split and wrap follow Settings until toggled here; both persist.
  const { settings } = useEngineSettings()
  const [layout, setLayout] = useState(readLayout)
  const changeLayout = (patch: Partial<Layout>): void =>
    setLayout((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
      } catch (error) {
        log.warn('Review layout could not be saved', { error: String(error) })
      }
      return next
    })
  const root = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const element = root.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 640)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Two columns are too narrow to read in a side panel, so it starts unified.
  const defaults = settings?.sourceControl
  const split = layout.split ?? (defaults?.diffView !== 'unified' && !narrow)
  const wrap = layout.wrap ?? defaults?.wrapDiffLines ?? false
  const filter = layout.tree ? storedFilter : ''

  const allFiles = useMemo(() => manifest?.files ?? [], [manifest])
  const files = useMemo(
    () =>
      filter
        ? allFiles.filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
        : allFiles,
    [allFiles, filter],
  )
  const totals = useMemo(
    () =>
      manifest
        ? manifest.files.reduce(
            (sum, file) => ({
              additions: sum.additions + file.additions,
              deletions: sum.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : null,
    [manifest],
  )

  // Which files are open: small reviews open whole, larger ones open the
  // first file; anything toggled by hand stays as left until the scope moves.
  const comparisonKey = JSON.stringify(comparison)
  const [toggled, setToggled] = useState<{ key: string; open: Map<string, boolean> }>(() => ({
    key: comparisonKey,
    open: new Map(),
  }))
  const overrides = toggled.key === comparisonKey ? toggled.open : null
  const openAll =
    allFiles.length <= OPEN_ALL_FILES &&
    (totals ? totals.additions + totals.deletions : 0) <= OPEN_ALL_LINES
  const firstPath = allFiles[0]?.path
  const isOpen = (path: string): boolean => overrides?.get(path) ?? (openAll || path === firstPath)
  const latestOpen = useRef(isOpen)
  latestOpen.current = isOpen
  const setOpen = useCallback(
    (path: string, open: boolean) =>
      setToggled((current) => {
        const map = new Map(current.key === comparisonKey ? current.open : [])
        map.set(path, open)
        return { key: comparisonKey, open: map }
      }),
    [comparisonKey],
  )
  const toggle = useCallback((path: string) => setOpen(path, !latestOpen.current(path)), [setOpen])

  // The stack's scroller and a version that moves whenever its content
  // resizes, so inline diffs can find where they start.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const [layoutVersion, setLayoutVersion] = useState(0)
  useEffect(() => {
    const element = content
    if (!element || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setLayoutVersion((value) => value + 1))
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [content])
  // A file picked in the tree opens and scrolls to the top; while its patch
  // loads the stack may be too short to get there, so it keeps trying briefly.
  const [reveal, setReveal] = useState<{ path: string; at: number } | null>(null)
  useEffect(() => {
    if (!reveal || !scroller || Date.now() - reveal.at > 1500) return
    const target = [...scroller.querySelectorAll<HTMLElement>('[data-path]')].find(
      (element) => element.dataset['path'] === reveal.path,
    )
    if (target) scroller.scrollTop = target.offsetTop
  }, [reveal, scroller, layoutVersion])

  const patches = useMemo(() => new PatchCache(), [])
  const changeComparison = (next: GitComparison): void => {
    if (remote && (next.kind === 'branch' || next.kind === 'commit')) return
    preferences.change({ comparison: next })
    onViewChange?.('changes')
  }

  // Stage, unstage and discard from a file row, against the snapshot on screen.
  const mutations = useGitMutations(scope, refresh, { branch: context?.status.branch ?? null })
  const shown = manifest?.comparison?.kind ?? comparison.kind
  const mutable = manifest !== null && ['working-tree', 'unstaged', 'staged'].includes(shown)
  // Index state wins over the manifest's copy: it is what stage and discard act on.
  const status = useMemo(
    () =>
      new Map(
        [...allFiles, ...(context?.status.files ?? [])].map((file) => [file.path, file] as const),
      ),
    [allFiles, context],
  )
  const latest = useRef({ manifest, mutations })
  latest.current = { manifest, mutations }
  const onAction = useCallback((action: FileAction, path: string) => {
    const { manifest, mutations } = latest.current
    if (!manifest) return
    if (action === 'discard')
      mutations.request({
        kind: 'discard',
        snapshotId: manifest.id,
        paths: [path],
        confirmed: true,
      })
    else mutations.request({ kind: action, snapshotId: manifest.id, paths: [path] })
  }, [])
  const rangeHandler = useRef(onRange)
  rangeHandler.current = onRange
  const stableRange = useCallback(
    (path: string, comparisonId: string, range: DiffRange) =>
      rangeHandler.current?.(path, comparisonId, range),
    [],
  )
  const flags = (path: string) => {
    if (!mutable) return { canStage: false, canUnstage: false, canDiscard: false }
    const file = status.get(path)
    const unstaged = Boolean(file?.unstaged)
    const staged = Boolean(file?.staged)
    return {
      canStage: shown !== 'staged' && unstaged,
      canUnstage: shown === 'staged' ? staged : shown === 'working-tree' && staged && !unstaged,
      canDiscard: shown !== 'staged' && unstaged,
    }
  }
  const bulk = useMemo(() => {
    const paths = (key: 'staged' | 'unstaged') =>
      allFiles
        .filter((file) => status.get(file.path)?.[key])
        .slice(0, 500)
        .map((file) => file.path)
    return { staged: paths('staged'), unstaged: paths('unstaged') }
  }, [allFiles, status])

  // Turn labels follow capture order; the menu lists the newest first.
  const [turnTimes, setTurnTimes] = useState<Record<string, number>>({})
  const turnIds = context?.turns ?? []
  const turnLabel = (turnId: string): string => {
    const index = turnIds.findIndex((turn) => turn.turnId === turnId)
    return index >= 0 ? `Turn ${index + 1}` : 'Turn'
  }
  const turns: ScopeTurn[] = turnIds
    .map((turn, index) => ({
      turnId: turn.turnId,
      label: `Turn ${index + 1}`,
      stable: turn.stable,
      ...(turn.error ? { error: turn.error } : {}),
      ...(turnTimes[turn.turnId] !== undefined ? { when: ago(turnTimes[turn.turnId]!) } : {}),
    }))
    .reverse()
  const loadTurnTimes = (): void => {
    if (!scope.sessionId || remote || rpc.readOnly) return
    if (turnIds.every((turn) => turn.turnId in turnTimes)) return
    void rpc
      .invoke('session.load', { sessionId: scope.sessionId })
      .then((model) => setTurnTimes(turnStarts(model)))
      .catch((error: unknown) => log.debug('Turn times unavailable', { error: String(error) }))
  }

  const refs = context?.refs ?? []
  // Once a branch review has loaded, its base label names the ref the engine
  // actually resolved; before that, the same rule the engine uses.
  const resolved =
    manifest?.comparison?.kind === 'branch' && !manifest.comparison.base
      ? /^Merge base · (.+)$/.exec(manifest.baseLabel)?.[1]
      : undefined
  const auto = resolved ?? automaticBase(refs)
  const scopeLabel = requests
    ? 'Pull requests'
    : comparison.kind === 'working-tree'
      ? 'Working tree'
      : comparison.kind === 'staged'
        ? 'Staged'
        : comparison.kind === 'unstaged'
          ? 'Unstaged'
          : comparison.kind === 'branch'
            ? 'Branch'
            : comparison.kind === 'session'
              ? 'This session'
              : comparison.kind === 'turn'
                ? turnLabel(comparison.turnId)
                : `Commit ${comparison.ref.slice(0, 7)}`
  const hostReason = remote ? 'Branch and commit comparisons are unavailable on this host.' : null

  const toggleClass = (on: boolean) => cx(iconButton, on && iconButtonActive)
  const header = (
    <header className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border pl-2 pr-1.5">
      <h2 className="sr-only">{label}</h2>
      <ScopeMenu
        label={scopeLabel}
        tooltip={
          manifest && !requests ? `${manifest.baseLabel} → ${manifest.headLabel}` : undefined
        }
        comparison={comparison}
        requests={requests}
        totals={allFiles.length ? totals : null}
        sessionScoped={Boolean(scope.sessionId)}
        branchLabel={`Branch vs ${comparison.kind === 'branch' && comparison.base ? comparison.base : auto}`}
        turns={turns}
        commits={(context?.commits ?? []).slice(0, 5)}
        hostReason={hostReason}
        requestsReason={administrationReason}
        bulk={
          mutable && !requests && manifest
            ? {
                stage:
                  bulk.unstaged.length && shown !== 'staged'
                    ? () =>
                        mutations.request({
                          kind: 'stage',
                          snapshotId: manifest.id,
                          paths: bulk.unstaged,
                        })
                    : null,
                unstage:
                  bulk.staged.length && shown !== 'unstaged'
                    ? () =>
                        mutations.request({
                          kind: 'unstage',
                          snapshotId: manifest.id,
                          paths: bulk.staged,
                        })
                    : null,
                reason: mutations.unavailableReason,
              }
            : null
        }
        onOpen={loadTurnTimes}
        onComparison={changeComparison}
        onRequests={() => onViewChange?.('requests')}
      />
      {!requests && comparison.kind === 'branch' ? (
        <BasePicker
          base={comparison.base}
          automatic={auto}
          refs={refs}
          onBase={(base) =>
            preferences.change({ comparison: { kind: 'branch', ...(base ? { base } : {}) } })
          }
        />
      ) : null}
      {!requests && totals && (totals.additions || totals.deletions) ? (
        <span className="flex shrink-0 gap-1.5 pl-1 font-mono text-[11px] tabular-nums">
          {totals.additions ? <span className="text-success">+{totals.additions}</span> : null}
          {totals.deletions ? <span className="text-danger">−{totals.deletions}</span> : null}
        </span>
      ) : null}
      <div className="min-w-2 flex-1" />
      {!requests ? (
        <>
          {comparison.kind === 'turn' && scope.sessionId ? (
            <TurnRevert
              sessionId={scope.sessionId}
              turnId={comparison.turnId}
              label={turnLabel(comparison.turnId)}
              disabledReason={administrationReason}
              onReverted={() => {
                preferences.change({ comparison: { kind: 'working-tree' } })
                refresh()
              }}
            />
          ) : null}
          <button
            type="button"
            aria-label="Split view"
            title={split ? 'Show diffs in one column' : 'Show diffs side by side'}
            aria-pressed={split}
            onClick={() => changeLayout({ split: !split })}
            className={toggleClass(split)}
          >
            <Columns2 size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Wrap lines"
            title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-pressed={wrap}
            onClick={() => changeLayout({ wrap: !wrap })}
            className={toggleClass(wrap)}
          >
            <TextWrap size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="File tree"
            title={layout.tree ? 'Hide the file tree' : 'Show the file tree'}
            aria-pressed={layout.tree}
            onClick={() => changeLayout({ tree: !layout.tree })}
            className={toggleClass(layout.tree)}
          >
            <ListTree size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Refresh changes"
            title="Refresh"
            onClick={refresh}
            className={iconButton}
          >
            <RefreshCw size={14} aria-hidden className={loading ? 'animate-spin' : ''} />
          </button>
        </>
      ) : null}
      {tools}
    </header>
  )

  const failure = error ?? watchError
  const clean =
    comparison.kind === 'working-tree'
      ? 'Working tree is clean.'
      : comparison.kind === 'turn'
        ? 'No changes in this turn.'
        : comparison.kind === 'staged'
          ? 'Nothing is staged.'
          : 'This comparison has no net changes.'
  return (
    <section
      ref={root}
      className="@container flex h-full min-h-0 flex-col bg-bg"
      aria-label={label}
    >
      {header}
      {requests ? (
        <div className="min-h-0 flex-1">
          {administrationReason ? (
            <p role="status" className="p-4 text-[13px] text-fg-muted">
              {administrationReason}
            </p>
          ) : (
            <ChangeRequests scope={scope} onCheckedOut={onCheckedOut} />
          )}
        </div>
      ) : (
        <>
          {failure ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 text-[13px] text-danger"
            >
              <span className="min-w-0 flex-1">{failure}</span>
              <button
                type="button"
                className="shrink-0 text-fg-muted underline hover:text-fg"
                onClick={refresh}
              >
                Retry
              </button>
            </div>
          ) : null}
          {mutations.error ? (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 text-[13px] text-danger"
            >
              <span className="min-w-0 flex-1">{mutations.error}</span>
              <button
                type="button"
                className="shrink-0 text-fg-muted underline hover:text-fg"
                onClick={mutations.dismiss}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col @[44rem]:flex-row">
            {layout.tree && allFiles.length ? (
              <aside
                aria-label="File tree"
                className="flex max-h-[40%] w-full shrink-0 flex-col border-b border-border @[44rem]:max-h-none @[44rem]:w-72 @[44rem]:border-b-0 @[44rem]:border-r"
              >
                <label className="mx-2 mb-1 mt-2 flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface-1 px-2 transition-colors focus-within:border-border-strong focus-within:ring-2 focus-within:ring-accent-ring hover:border-border-strong">
                  <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden />
                  <input
                    aria-label="Filter changed files"
                    value={filter}
                    onChange={(event) => preferences.change({ filter: event.target.value })}
                    maxLength={256}
                    placeholder="Filter files…"
                    className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
                  />
                </label>
                <ChangedFiles
                  files={files}
                  selected={reveal?.path}
                  tree={!filter}
                  onSelect={(path) => {
                    setOpen(path, true)
                    setReveal({ path, at: Date.now() })
                  }}
                />
              </aside>
            ) : null}
            <div
              ref={setScroller}
              className="ari-scroll relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
            >
              {manifest && files.length ? (
                <div ref={setContent}>
                  {files.map((file, index) => {
                    const open = isOpen(file.path)
                    return (
                      <FileSection
                        key={file.path}
                        rpc={rpc}
                        scope={scope}
                        manifest={manifest}
                        file={file}
                        open={open}
                        first={index === 0}
                        {...flags(file.path)}
                        actionsReason={
                          mutations.unavailableReason ?? (mutations.busy ? 'Working…' : null)
                        }
                        dragKey={dragKey}
                        split={split}
                        wrap={wrap}
                        scroller={scroller}
                        layoutVersion={open ? layoutVersion : 0}
                        cache={patches}
                        onToggle={toggle}
                        onAction={onAction}
                        onRange={onRange ? stableRange : undefined}
                      />
                    )
                  })}
                  {manifest.truncated ? (
                    <p className="border-t border-border px-3 py-2 text-xs text-fg-subtle">
                      Showing the first {manifest.files.length} changed files.
                    </p>
                  ) : null}
                </div>
              ) : manifest && allFiles.length ? (
                <p className="flex h-full items-center justify-center p-8 text-center text-[13px] text-fg-subtle">
                  No changed files match this filter.
                </p>
              ) : manifest ? (
                <div className="flex h-full flex-col items-center justify-center gap-2.5 p-8 text-center text-[13px] text-fg-subtle">
                  <p>{clean}</p>
                  {scope.sessionId && comparison.kind === 'working-tree' ? (
                    <button
                      type="button"
                      onClick={() => changeComparison({ kind: 'session' })}
                      className="h-7 rounded-md bg-fg/5 px-2.5 text-[12.5px] text-fg transition-colors hover:bg-fg/9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      Show this session's changes
                    </button>
                  ) : null}
                </div>
              ) : loading ? (
                <div role="status" aria-label="Loading changes">
                  {[46, 62, 38, 54].map((width, index) => (
                    <div
                      key={width}
                      className={cx(
                        'flex h-8 items-center gap-2 px-2',
                        index > 0 && 'border-t border-border',
                      )}
                    >
                      <span className="size-3.5 shrink-0" />
                      <span className="size-1.5 shrink-0 rounded-full bg-fg/10" />
                      <span
                        className="h-2.5 animate-pulse rounded bg-fg/6"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
      {mutations.dialog}
    </section>
  )
}
