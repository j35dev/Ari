import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder, FolderPlus, RefreshCw, Search } from 'lucide-react'
import type { DiscoveredProject, ProjectDiscovery } from '@ari/contracts/project'
import { Button } from '@ari/ui/button'
import { Checkbox } from '@ari/ui/checkbox'
import { Skeleton } from '@ari/ui/skeleton'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { projectPathKey } from './project-path-key'

const log = createLogger('onboarding:projects')

/** Offers local folders without importing or granting access until the final confirmation. */
export function OnboardingProjects({
  selected,
  onChange,
}: {
  selected: DiscoveredProject[]
  onChange: (projects: DiscoveredProject[]) => void
}) {
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null)
  const [manual, setManual] = useState<DiscoveredProject[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const lifetime = useRef(0)
  const picking = useRef(false)
  const latestSelected = useRef(selected)
  latestSelected.current = selected
  const scan = useCallback(async () => {
    const mine = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await rpc.invoke('project.discover')
      if (mine === generation.current) setDiscovery(result)
    } catch (error) {
      log.warn('project discovery failed', error)
      if (mine === generation.current)
        setError('Could not find recent projects. Try again or choose a folder yourself.')
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    lifetime.current++
    void scan()
    return () => {
      lifetime.current++
      generation.current++
    }
  }, [scan])
  const browse = async (): Promise<void> => {
    if (picking.current) return
    picking.current = true
    const mine = lifetime.current
    setBrowsing(true)
    setError(null)
    try {
      const { path } = await rpc.invoke('dialog.pickFolder', {})
      if (!path || mine !== lifetime.current) return
      const project: DiscoveredProject = {
        path,
        name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
        sources: [],
        lastUsedAt: null,
      }
      const key = projectPathKey(path)
      setManual((prev) =>
        prev.some((p) => projectPathKey(p.path) === key) ? prev : [...prev, project],
      )
      if (!latestSelected.current.some((p) => projectPathKey(p.path) === key))
        onChange([...latestSelected.current, project])
      setQuery('')
    } catch (error) {
      log.warn('folder picker failed', error)
      if (mine === lifetime.current) setError('Could not open the folder picker. Try again.')
    } finally {
      picking.current = false
      if (mine === lifetime.current) setBrowsing(false)
    }
  }
  const projects = [
    ...new Map(
      [...manual, ...selected, ...(discovery?.projects ?? [])].map((p) => [
        projectPathKey(p.path),
        p,
      ]),
    ).values(),
  ]
  const visible = projects.filter((p) =>
    `${p.name} ${p.path}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const selectedKeys = new Set(selected.map((p) => projectPathKey(p.path)))
  const allVisibleSelected =
    visible.length > 0 && visible.every((p) => selectedKeys.has(projectPathKey(p.path)))
  const toggleVisible = (): void => {
    const keys = new Set(visible.map((p) => projectPathKey(p.path)))
    onChange(
      allVisibleSelected
        ? selected.filter((p) => !keys.has(projectPathKey(p.path)))
        : [...selected, ...visible.filter((p) => !selectedKeys.has(projectPathKey(p.path)))],
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-fg-muted">
        Recent folders from Claude Code and Codex. Choose what belongs in Ari; your files stay where
        they are.
      </p>
      <div className="flex flex-wrap gap-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 text-fg-muted focus-within:ring-2 focus-within:ring-accent-ring">
          <Search size={14} aria-hidden />
          <input
            aria-label="Find a project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a project…"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
          />
        </label>
        <Button disabled={browsing} onClick={() => void browse()}>
          <FolderPlus size={14} aria-hidden /> {browsing ? 'Opening…' : 'Choose folder'}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span role="status">
          {selected.length} selected
          {loading ? ' · Looking for projects…' : ` · ${projects.length} found`}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={visible.length === 0} onClick={toggleVisible}>
            {allVisibleSelected
              ? 'Clear selection'
              : query.trim()
                ? 'Select matches'
                : 'Select all'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh projects"
            disabled={loading}
            onClick={() => void scan()}
          >
            <RefreshCw size={13} aria-hidden />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {loading && projects.length === 0 ? (
        <div aria-label="Looking for recent projects" className="space-y-3 py-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} h={66} className="rounded-lg" />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <ul
          aria-label="Recent projects"
          className="ari-scroll max-h-72 overflow-y-auto rounded-xl border border-border bg-surface-1"
        >
          {visible.map((project) => {
            const key = projectPathKey(project.path)
            const checked = selectedKeys.has(key)
            return (
              <li key={key} className="border-b border-border/60 last:border-b-0">
                <Checkbox
                  aria-label={`Add ${project.name} (${project.path})`}
                  checked={checked}
                  onChange={() =>
                    onChange(
                      checked
                        ? selected.filter((p) => projectPathKey(p.path) !== key)
                        : [...selected, project],
                    )
                  }
                  className={`w-full gap-3 px-4 py-3 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1 ${checked ? 'bg-accent-subtle/50' : 'hover:bg-surface-2'}`}
                >
                  <span className="flex items-center gap-3">
                    <Folder
                      size={18}
                      className={checked ? 'shrink-0 text-accent' : 'shrink-0 text-fg-subtle'}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {project.name}
                      </span>
                      <span
                        title={project.path}
                        className="mt-1 block truncate font-mono text-2xs text-fg-muted"
                      >
                        {project.path}
                      </span>
                    </span>
                    <span className="shrink-0 text-2xs text-fg-subtle">
                      {project.sources.length === 0
                        ? 'Chosen by you'
                        : project.sources
                            .map((s) => (s === 'claude' ? 'Claude' : 'Codex'))
                            .join(' · ')}
                    </span>
                  </span>
                </Checkbox>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-6 py-9 text-center">
          <FolderPlus size={25} className="mx-auto mb-3 text-fg-subtle" aria-hidden />
          <h3 className="text-sm font-medium">
            {query ? 'No matching projects' : 'Start with a folder.'}
          </h3>
          <p className="mt-2 text-xs text-fg-muted">
            {query
              ? 'Try another name or path.'
              : 'Choose a folder above, or add your first project later.'}
          </p>
        </div>
      )}
      {discovery?.truncated && (
        <p role="status" className="text-xs text-warning">
          Showing a partial scan to keep setup fast. Choose any missing folder manually.
        </p>
      )}
      {discovery?.warnings.map((warning) => (
        <p key={warning} className="text-xs text-warning">
          {warning}
        </p>
      ))}
      <p className="text-2xs leading-relaxed text-fg-subtle">
        Only selected folders are added when you finish setup. Conversation history is not copied,
        and no agent is started.
      </p>
    </div>
  )
}
