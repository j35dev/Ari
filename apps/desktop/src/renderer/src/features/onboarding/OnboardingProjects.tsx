import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderPlus, RefreshCw, Search } from 'lucide-react'
import type { DiscoveredProject, ProjectDiscovery } from '@ari/contracts/project'
import { Button } from '@ari/ui/button'
import { Checkbox } from '@ari/ui/checkbox'
import { Input } from '@ari/ui/input'
import { Skeleton } from '@ari/ui/skeleton'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { LetterTile } from './OnboardingReady'
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
      <p className="text-sm leading-relaxed text-fg-muted">
        Recent folders from Claude Code and Codex. Choose what belongs in Ari; your files stay where
        they are.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Find a project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a project…"
          className="min-w-0 flex-1"
          leading={<Search size={14} strokeWidth={1.7} aria-hidden />}
        />
        <Button disabled={browsing} onClick={() => void browse()}>
          <FolderPlus size={14} strokeWidth={1.7} aria-hidden />{' '}
          {browsing ? 'Opening…' : 'Choose folder'}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 text-[13px] text-fg-subtle">
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
            <RefreshCw size={14} strokeWidth={1.7} aria-hidden />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2.5 text-[13px] leading-5 text-fg">
          <span className="ari-status mt-[3px]" data-status="error" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}
      {loading && projects.length === 0 ? (
        <div aria-label="Looking for recent projects" className="space-y-2 py-1">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} h={48} className="rounded-md" />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <ul
          aria-label="Recent projects"
          className="ari-scroll max-h-72 divide-y divide-border overflow-y-auto border-y border-border"
        >
          {visible.map((project) => {
            const key = projectPathKey(project.path)
            const checked = selectedKeys.has(key)
            return (
              <li key={key}>
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
                  className="w-full gap-3 px-2 py-2.5 transition-colors hover:bg-fg/5 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
                >
                  <span className="flex items-center gap-3">
                    <LetterTile name={project.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {project.name}
                      </span>
                      <span
                        title={project.path}
                        className="mt-0.5 block truncate font-mono text-xs text-fg-subtle"
                      >
                        {project.path}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">
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
        <div className="border-y border-border px-2 py-6">
          <h3 className="text-sm font-medium text-fg">
            {query ? 'No matching projects' : 'Start with a folder.'}
          </h3>
          <p className="mt-0.5 text-[13px] text-fg-subtle">
            {query
              ? 'Try another name or path.'
              : 'Choose a folder above, or add your first project later.'}
          </p>
        </div>
      )}
      {discovery?.truncated && (
        <p role="status" className="text-[13px] leading-5 text-fg-muted">
          Showing a partial scan to keep setup fast. Choose any missing folder manually.
        </p>
      )}
      {discovery?.warnings.map((warning) => (
        <p key={warning} className="text-[13px] leading-5 text-fg-muted">
          {warning}
        </p>
      ))}
      <p className="text-[13px] leading-5 text-fg-subtle">
        Only selected folders are added when you finish setup. Conversation history is not copied,
        and no agent is started.
      </p>
    </div>
  )
}
