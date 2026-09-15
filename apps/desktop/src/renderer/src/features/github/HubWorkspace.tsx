import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleDot, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react'
import type { GitHubHubItem } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { createLogger } from '@ari/shared/logger'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { Skeleton } from '@ari/ui/skeleton'
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

function statusBadge(item: GitHubHubItem) {
  const state = item.state.toUpperCase()
  if (item.kind === 'pr' && item.isDraft) return { tone: 'warning' as const, label: 'Draft' }
  if (state === 'MERGED') return { tone: 'accent' as const, label: 'Merged' }
  if (state === 'CLOSED') return { tone: 'danger' as const, label: 'Closed' }
  return { tone: 'success' as const, label: 'Open' }
}

function matchesQuery(item: GitHubHubItem, query: string): boolean {
  if (query.length === 0) return true
  const hay = `${item.number} ${item.title} ${item.author} ${item.labels.map((l) => l.name).join(' ')}`
  return hay.toLowerCase().includes(query)
}

/** Settings-style workspace for GitHub pull requests and issues, scoped to one Ari project. */
export function HubWorkspace({ projects, initialProjectId, onBack }: HubWorkspaceProps) {
  const usable = projects.filter((project) => project.status !== 'missing')
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
      <aside className="ari-glass flex w-[var(--ari-sidebar-width)] shrink-0 flex-col">
        <div className="flex items-center gap-1.5 px-2 pb-1 pt-3">
          <button
            type="button"
            aria-label="Back"
            title="Back to workspace"
            onClick={onBack}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <ArrowLeft size={14} strokeWidth={1.8} aria-hidden />
          </button>
          <span className="text-sm font-semibold tracking-tight text-fg">PRs & issues</span>
        </div>
        <p className="px-4 pb-2 text-xs leading-relaxed text-fg-muted">
          GitHub activity for each project Ari knows about.
        </p>
        <nav aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {usable.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-fg-subtle">No projects yet.</p>
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
                      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                        selected
                          ? 'bg-accent-subtle font-medium text-fg'
                          : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
                      }`}
                    >
                      <span className="min-w-0 truncate">{entry.name}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <header className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-border px-4 text-xs">
          <span className="text-fg-muted">PRs & issues</span>
          <span className="text-fg-subtle">/</span>
          <span className="font-medium text-fg">{project?.name ?? 'No project'}</span>
        </header>

        {project === null ? (
          <div className="mx-auto flex max-w-lg flex-col gap-2 p-8">
            <h1 className="text-lg font-semibold text-fg">Open a project first</h1>
            <p className="text-sm leading-relaxed text-fg-muted">
              Ari lists pull requests and issues through the GitHub CLI in each project folder. Add
              a project from the sidebar, then come back here.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
              <div className="flex flex-col gap-2 border-b border-border p-3">
                <SegmentedControl
                  aria-label="Pull requests or issues"
                  size="sm"
                  value={kind}
                  options={KIND_OPTIONS}
                  onChange={(value) => setKind(value as HubKind)}
                  className="w-full [&_button]:flex-1"
                />
                <div className="flex items-center gap-2">
                  <SegmentedControl
                    aria-label="State"
                    size="sm"
                    value={state}
                    options={STATE_OPTIONS}
                    onChange={(value) => setState(value as HubState)}
                  />
                  <button
                    type="button"
                    aria-label="Refresh"
                    title="Refresh"
                    onClick={() => setReloadToken((token) => token + 1)}
                    className="ml-auto flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    <RefreshCw size={13} aria-hidden />
                  </button>
                </div>
                <Input
                  aria-label={`Filter ${noun}s`}
                  placeholder="Filter by title, number, author"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="ari-scroll min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex flex-col gap-2 p-3">
                    <Skeleton h={44} />
                    <Skeleton h={44} />
                    <Skeleton h={44} />
                  </div>
                ) : error !== null ? (
                  <p className="px-4 py-6 text-sm leading-relaxed text-fg-muted">{error}</p>
                ) : filtered.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-fg-subtle">
                    {items.length === 0 ? `No ${state} ${noun}s.` : 'Nothing matches that filter.'}
                  </p>
                ) : (
                  <ul aria-label={kind === 'pr' ? 'Pull requests' : 'Issues'}>
                    {filtered.map((item) => {
                      const selected = item.number === selectedNumber
                      const badge = statusBadge(item)
                      const KindIcon = item.kind === 'pr' ? GitPullRequest : CircleDot
                      return (
                        <li key={item.number} className="border-b border-border/60">
                          <button
                            type="button"
                            aria-current={selected ? 'true' : undefined}
                            onClick={() => setSelectedNumber(item.number)}
                            className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
                              selected ? 'bg-accent-subtle' : 'hover:bg-glass-hover'
                            }`}
                          >
                            <span className="flex items-start gap-2">
                              <KindIcon
                                size={14}
                                className="mt-0.5 shrink-0 text-fg-muted"
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1 text-sm font-medium text-fg">
                                {item.title}
                              </span>
                              <Badge tone={badge.tone} size="sm">
                                {badge.label}
                              </Badge>
                            </span>
                            <span className="pl-6 text-xs text-fg-muted">
                              #{item.number} · {item.author} · {formatUpdatedAt(item.updatedAt)}
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
                <div className="flex flex-col gap-3 p-8">
                  <Skeleton h={28} className="w-2/3" />
                  <Skeleton h={16} className="w-1/3" />
                  <Skeleton h={160} />
                </div>
              ) : detail === null ? (
                <p className="p-8 text-sm text-fg-muted">
                  {detailError ?? `Could not load this ${noun}.`}
                </p>
              ) : (
                <article className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={statusBadge(detail).tone} size="sm">
                          {statusBadge(detail).label}
                        </Badge>
                        <span className="text-xs text-fg-muted">#{detail.number}</span>
                      </div>
                      <h1 className="text-xl font-semibold tracking-tight text-fg">
                        {detail.title}
                      </h1>
                      <p className="text-xs text-fg-muted">
                        {detail.author}
                        {detail.headRefName
                          ? ` · ${detail.headRefName}${detail.baseRefName ? ` → ${detail.baseRefName}` : ''}`
                          : ''}
                        {detail.additions !== undefined && detail.deletions !== undefined
                          ? ` · +${detail.additions} −${detail.deletions}`
                          : ''}
                        {` · ${formatUpdatedAt(detail.updatedAt)}`}
                      </p>
                      {detail.labels.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {detail.labels.map((label) => (
                            <span
                              key={label.name}
                              className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-px text-2xs text-fg-muted"
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
                      onClick={() => openOnGitHub(detail.url)}
                      aria-label="Open on GitHub"
                    >
                      <ExternalLink size={13} aria-hidden />
                      GitHub
                    </Button>
                  </div>
                  {detailError !== null ? (
                    <p className="text-xs text-fg-muted">{detailError}</p>
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
      </section>
    </div>
  )
}
