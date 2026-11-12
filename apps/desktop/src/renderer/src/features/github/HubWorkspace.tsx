import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CircleDot,
  CircleSlash,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { GitHubHubItem } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { Skeleton } from '@ari/ui/skeleton'
import { cx, iconButton, rowSelected, sectionLabel, tabSelected } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { MarkdownBlock } from '../transcript/MarkdownBlock'
import { formatUpdatedAt } from './format-updated'

const log = createLogger('ui:github-hub')

type HubKind = 'pr' | 'issue'
type HubState = 'open' | 'closed' | 'all'

const KIND_OPTIONS = [
  { value: 'pr', label: 'PRs' },
  { value: 'issue', label: 'Issues' },
]

const STATE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

export interface HubWorkspaceProps {
  projects: Project[]
  initialProjectId?: string | null
  onBack: () => void
}

/**
 * An item's state as one glyph: the git icon says what it is, and only merged
 * and closed take a colour. `label` names the glyph for assistive technology.
 */
function itemStatus(item: GitHubHubItem): { icon: LucideIcon; tone: string; label: string } {
  const state = item.state.toUpperCase()
  if (item.kind === 'pr' && item.isDraft) {
    return { icon: GitPullRequestDraft, tone: 'text-fg-subtle', label: 'Draft' }
  }
  if (state === 'MERGED') return { icon: GitMerge, tone: 'text-success', label: 'Merged' }
  if (state === 'CLOSED') {
    return {
      icon: item.kind === 'pr' ? GitPullRequestClosed : CircleSlash,
      tone: 'text-danger',
      label: 'Closed',
    }
  }
  return {
    icon: item.kind === 'pr' ? GitPullRequest : CircleDot,
    tone: 'text-fg-subtle',
    label: 'Open',
  }
}

/**
 * The `row` recipe at the frame's nav size (34px, 14px). Colour is set per
 * state rather than layered: `row`'s muted text would outrank `rowSelected`'s
 * in the stylesheet.
 */
const NAV_ROW =
  'flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
const NAV_ROW_IDLE = 'text-fg-muted hover:bg-fg/5 hover:text-fg'

/** The `tab` recipe, with the colour chosen per state for the same reason. */
const KIND_TAB =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
const KIND_TAB_IDLE = 'text-fg-subtle hover:text-fg'

/** The reading column inside the stage, as on a settings page. */
const PAGE_COLUMN = 'mx-auto w-full max-w-[744px] px-8 pb-16 pt-11'

/**
 * The line under a detail title: state, number, author, branches, diff size
 * and age. Spaced apart rather than chained with dots; mono is for the branch
 * names and the counts only.
 */
function DetailMeta({ item }: { item: GitHubHubItem }) {
  const status = itemStatus(item)
  const StatusIcon = status.icon
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-subtle">
      <span className="inline-flex items-center gap-1.5">
        <StatusIcon size={14} strokeWidth={1.7} className={status.tone} aria-hidden />
        {status.label}
      </span>
      <span>#{item.number}</span>
      <span>{item.author}</span>
      {item.headRefName ? (
        <span className="font-mono text-fg-muted">
          {item.headRefName}
          {item.baseRefName ? ` → ${item.baseRefName}` : ''}
        </span>
      ) : null}
      {item.additions !== undefined && item.deletions !== undefined ? (
        <span className="font-mono">
          <span className="text-success">+{item.additions}</span>{' '}
          <span className="text-danger">−{item.deletions}</span>
        </span>
      ) : null}
      <span>{formatUpdatedAt(item.updatedAt)}</span>
    </p>
  )
}

function matchesQuery(item: GitHubHubItem, query: string): boolean {
  if (query.length === 0) return true
  const hay = `${item.number} ${item.title} ${item.author} ${item.labels.map((l) => l.name).join(' ')}`
  return hay.toLowerCase().includes(query)
}

/** Settings-style workspace for GitHub pull requests and issues, scoped to one Ari project. */
export function HubWorkspace({ projects, initialProjectId, onBack }: HubWorkspaceProps) {
  const usable = useMemo(
    () => projects.filter((project) => project.status !== 'missing'),
    [projects],
  )
  const [projectId, setProjectId] = useState<string | null>(
    () => usable.find((project) => project.id === initialProjectId)?.id ?? usable[0]?.id ?? null,
  )
  const [kind, setKind] = useState<HubKind>('pr')
  const [state, setState] = useState<HubState>('open')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<GitHubHubItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [detail, setDetail] = useState<GitHubHubItem | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  // The hub can be opened before `projects.list` resolves, and the initializer
  // above only ran once — so without this a hub opened at startup stays stuck
  // on its empty state even after the projects arrive. This also lets go of a
  // project that has since been removed or gone missing.
  useEffect(() => {
    setProjectId((current) => {
      if (current !== null && usable.some((entry) => entry.id === current)) return current
      return usable.find((entry) => entry.id === initialProjectId)?.id ?? usable[0]?.id ?? null
    })
  }, [usable, initialProjectId])

  const project = usable.find((entry) => entry.id === projectId) ?? null
  const noun = kind === 'pr' ? 'pull request' : 'issue'
  const filtered = useMemo(
    () => items.filter((item) => matchesQuery(item, query.trim().toLowerCase())),
    [items, query],
  )

  useEffect(() => {
    if (projectId === null) {
      setItems([])
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setSelectedNumber(null)
    setDetail(null)
    void rpc
      .invoke('github.list', { projectId, kind, state })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setItems([])
          setError(result.error ?? `Could not load ${noun}s.`)
          return
        }
        setItems(result.items)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        log.warn('github.list failed', { error: caught })
        setItems([])
        setError('Could not load GitHub data.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, kind, state, reloadToken, noun])

  useEffect(() => {
    if (projectId === null || selectedNumber === null) {
      setDetail(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    const preview = items.find((item) => item.number === selectedNumber) ?? null
    setDetail(preview)
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    void rpc
      .invoke('github.view', { projectId, kind, number: selectedNumber })
      .then((result) => {
        if (cancelled) return
        if (!result.ok || result.item === null) {
          setDetailError(result.error ?? `Could not load this ${noun}.`)
          return
        }
        setDetail(result.item)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        log.warn('github.view failed', { error: caught })
        setDetailError(`Could not load this ${noun}.`)
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, kind, selectedNumber, items, noun])

  const openOnGitHub = (url: string) => {
    void rpc.invoke('shell.openUrl', { url }).catch((caught: unknown) => {
      log.warn('open GitHub url failed', { error: caught })
    })
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[var(--ari-sidebar-width)] shrink-0 flex-col px-2.5 pb-2.5 pt-1">
        {/* Back leads the list. The row is below the titlebar, so it clears the
            macOS hiddenInset traffic lights without needing a leading inset. */}
        <button
          type="button"
          aria-label="Back"
          title="Back to workspace"
          onClick={onBack}
          className={cx(NAV_ROW, NAV_ROW_IDLE, 'shrink-0')}
        >
          <ArrowLeft size={16} strokeWidth={1.7} className="shrink-0" aria-hidden />
          Back
        </button>
        <p className={`mb-1 mt-4 px-2.5 ${sectionLabel}`}>Projects</p>
        <nav
          aria-label="Projects"
          className="ari-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1"
        >
          {usable.length === 0 ? (
            <p className="px-2.5 py-2 text-[13.5px] text-fg-subtle">No projects yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {usable.map((entry) => {
                const selected = entry.id === projectId
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => setProjectId(entry.id)}
                      className={cx(NAV_ROW, selected ? rowSelected : NAV_ROW_IDLE)}
                    >
                      <span
                        aria-hidden
                        className="grid size-5 shrink-0 place-items-center rounded-sm bg-surface-2 text-[11px] font-medium text-fg-muted"
                      >
                        {entry.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 truncate">{entry.name}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
        <p className="shrink-0 px-2.5 pt-2 text-xs leading-relaxed text-fg-subtle">
          GitHub activity for each project Ari knows about.
        </p>
      </aside>

      <div className="ari-stage mb-[var(--ari-frame-gap)] mr-[var(--ari-frame-gap)] flex min-w-0 flex-1 flex-col">
        {project === null ? (
          <div className="ari-scroll min-h-0 flex-1 overflow-y-auto">
            <div className={PAGE_COLUMN}>
              <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg">
                Open a project first
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-fg-subtle">
                Ari lists pull requests and issues through the GitHub CLI in each project folder.
                Add a project from the sidebar, then come back here.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
              <div className="flex h-11 shrink-0 items-center gap-1 px-2.5">
                <div role="group" aria-label="Pull requests or issues" className="flex gap-0.5">
                  {KIND_OPTIONS.map((option) => {
                    const current = option.value === kind
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={current}
                        onClick={() => setKind(option.value as HubKind)}
                        className={cx(KIND_TAB, current ? tabSelected : KIND_TAB_IDLE)}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  aria-label="Refresh"
                  title="Refresh"
                  onClick={() => setReloadToken((token) => token + 1)}
                  className={`${iconButton} ml-auto`}
                >
                  <RefreshCw size={14} strokeWidth={1.7} aria-hidden />
                </button>
              </div>
              <div className="flex shrink-0 flex-col gap-2 border-b border-border px-2.5 pb-2.5">
                <Input
                  aria-label={`Filter ${noun}s`}
                  placeholder="Filter by title, number, author"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  leading={<Search size={14} strokeWidth={1.7} aria-hidden />}
                />
                <SegmentedControl
                  aria-label="State"
                  size="sm"
                  value={state}
                  options={STATE_OPTIONS}
                  onChange={(value) => setState(value as HubState)}
                  className="self-start"
                />
              </div>
              <div className="ari-scroll min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex flex-col gap-1.5 p-2.5">
                    <Skeleton h={48} />
                    <Skeleton h={48} />
                    <Skeleton h={48} />
                  </div>
                ) : error !== null ? (
                  <p className="px-5 py-5 text-sm leading-relaxed text-fg-muted">{error}</p>
                ) : filtered.length === 0 ? (
                  <p className="px-5 py-5 text-sm text-fg-subtle">
                    {items.length === 0 ? `No ${state} ${noun}s.` : 'Nothing matches that filter.'}
                  </p>
                ) : (
                  <ul
                    aria-label={kind === 'pr' ? 'Pull requests' : 'Issues'}
                    className="flex flex-col gap-0.5 p-1.5"
                  >
                    {filtered.map((item) => {
                      const selected = item.number === selectedNumber
                      const status = itemStatus(item)
                      const StatusIcon = status.icon
                      return (
                        <li key={item.number}>
                          <button
                            type="button"
                            aria-current={selected ? 'true' : undefined}
                            onClick={() => setSelectedNumber(item.number)}
                            className={cx(
                              'flex w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
                              selected ? 'bg-fg/9' : 'hover:bg-fg/5',
                            )}
                          >
                            <StatusIcon
                              size={16}
                              strokeWidth={1.7}
                              role="img"
                              aria-label={status.label}
                              className={`mt-0.5 shrink-0 ${status.tone}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-fg">{item.title}</span>
                              <span className="mt-0.5 flex min-w-0 gap-2 text-[12.5px] text-fg-subtle">
                                <span className="shrink-0">#{item.number}</span>
                                <span className="min-w-0 truncate">{item.author}</span>
                                <span className="shrink-0">{formatUpdatedAt(item.updatedAt)}</span>
                              </span>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>

            <div className="ari-scroll min-h-0 flex-1 overflow-y-auto">
              {selectedNumber === null ? (
                <div className="flex h-full items-center justify-center p-8">
                  <p className="text-sm text-fg-subtle">Select a {noun} to read it.</p>
                </div>
              ) : detail === null && detailLoading ? (
                <div className={`${PAGE_COLUMN} flex flex-col gap-3`}>
                  <Skeleton h={28} className="w-2/3" />
                  <Skeleton h={16} className="w-1/3" />
                  <Skeleton h={160} />
                </div>
              ) : detail === null ? (
                <p className={`${PAGE_COLUMN} text-sm text-fg-muted`}>
                  {detailError ?? `Could not load this ${noun}.`}
                </p>
              ) : (
                <article className={`${PAGE_COLUMN} flex flex-col gap-5`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg">
                        {detail.title}
                      </h1>
                      <DetailMeta item={detail} />
                      {detail.labels.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {detail.labels.map((label) => (
                            <span
                              key={label.name}
                              className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-fg-muted"
                            >
                              {label.color ? (
                                <span
                                  aria-hidden
                                  className="size-1.5 rounded-full"
                                  style={{ background: `#${label.color}` }}
                                />
                              ) : null}
                              {label.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0"
                      onClick={() => openOnGitHub(detail.url)}
                      aria-label="Open on GitHub"
                    >
                      <ExternalLink size={14} strokeWidth={1.7} aria-hidden />
                      GitHub
                    </Button>
                  </div>
                  {detailError !== null ? (
                    <p className="text-[13px] text-fg-subtle">{detailError}</p>
                  ) : null}
                  {detailLoading && detail.body.length === 0 ? (
                    <Skeleton h={120} />
                  ) : detail.body.trim().length === 0 ? (
                    <p className="text-sm text-fg-subtle">No description.</p>
                  ) : (
                    <MarkdownBlock text={detail.body} />
                  )}
                </article>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
