import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FolderPlus, Plus, Search } from 'lucide-react'
import type { DiscoveredProject, ProjectDiscovery } from '@ari/contracts/project'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Skeleton } from '@ari/ui/skeleton'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { ONBOARDING_LEAD_CLASS, ONBOARDING_TITLE_CLASS } from './OnboardingFrame'
import { StepFooter } from './StepFooter'
import { listItem, staggerList, useCalm } from './onboarding-motion'
import { projectPathKey } from './project-path-key'

const log = createLogger('onboarding:projects')

/** The most recent folders start ticked, up to this many. */
export const PRESELECT_LIMIT = 3
/** Past this many folders a filter field appears. */
const FILTER_FROM = 8

/** A project's initial on a small raised tile, as in the sidebar. */
export function LetterTile({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="ari-onboarding-tile text-[12px] font-semibold">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** "today", "yesterday", "3d ago", "2w ago", "4mo ago". */
export function lastActive(at: number | null, now = Date.now()): string | null {
  if (at === null || at <= 0) return null
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  if (days < 730) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** Offers local folders without importing anything until setup finishes. */
export function OnboardingProjects({
  selected,
  onChange,
  onBack,
  onContinue,
  headingRef,
  primaryRef,
}: {
  selected: readonly DiscoveredProject[]
  onChange: (projects: DiscoveredProject[]) => void
  onBack: () => void
  onContinue: () => void
  headingRef: Ref<HTMLHeadingElement>
  primaryRef: Ref<HTMLButtonElement>
}) {
  const calm = useCalm()
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null)
  const [manual, setManual] = useState<DiscoveredProject[]>([])
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const latest = useRef(selected)
  latest.current = selected
  const touched = useRef(selected.length > 0)

  const add = useCallback(
    (project: DiscoveredProject) => {
      const key = projectPathKey(project.path)
      setManual((prev) =>
        prev.some((p) => projectPathKey(p.path) === key) ? prev : [project, ...prev],
      )
      touched.current = true
      if (!latest.current.some((p) => projectPathKey(p.path) === key))
        onChange([...latest.current, project])
    },
    [onChange],
  )

  useEffect(() => {
    alive.current = true
    void rpc
      .invoke('project.discover')
      .then((result) => {
        if (!alive.current) return
        setDiscovery(result)
        // Pre-tick the most recent few, once, unless the user already chose.
        if (!touched.current && latest.current.length === 0) {
          touched.current = true
          const recent = result.projects.filter((p) => p.branch !== null).slice(0, PRESELECT_LIMIT)
          if (recent.length > 0) onChange(recent)
        }
      })
      .catch((failure: unknown) => {
        log.warn('project discovery failed', failure)
        if (alive.current) {
          setDiscovery({ projects: [], truncated: false, warnings: [] })
          setError('Ari could not look for recent projects. Choose a folder instead.')
        }
      })
    return () => {
      alive.current = false
    }
  }, [onChange])

  const browse = async (): Promise<void> => {
    if (browsing) return
    setBrowsing(true)
    setError(null)
    try {
      const { path } = await rpc.invoke('dialog.pickFolder', {})
      if (path && alive.current)
        add({ path, name: folderName(path), sources: [], lastUsedAt: null, branch: null })
    } catch (failure) {
      log.warn('folder picker failed', failure)
      if (alive.current) setError('Could not open the folder picker. Try again.')
    } finally {
      if (alive.current) setBrowsing(false)
    }
  }

  const create = async (): Promise<void> => {
    const name = creating?.trim() ?? ''
    if (name === '' || saving) return
    setSaving(true)
    setError(null)
    try {
      const project = await rpc.invoke('project.create', { name })
      if (!alive.current) return
      add({
        path: project.path,
        name: project.name,
        sources: [],
        lastUsedAt: Date.now(),
        branch: null,
      })
      setCreating(null)
    } catch (failure) {
      log.warn('project create failed', failure)
      if (alive.current)
        setError(
          failure instanceof Error && failure.message
            ? failure.message
            : 'Could not create the project. Try another name.',
        )
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  // Git repositories only: agent history also remembers scratch and temp folders.
  const repositories = (discovery?.projects ?? []).filter((p) => p.branch !== null)
  const projects = [
    ...new Map(
      [...manual, ...repositories, ...selected].map((p) => [projectPathKey(p.path), p]),
    ).values(),
  ]
  const needle = query.trim().toLowerCase()
  const visible = projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(needle))
  const keys = new Set(selected.map((p) => projectPathKey(p.path)))
  const count = selected.length

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
        Open your projects
      </h2>
      <p className={ONBOARDING_LEAD_CLASS}>
        Found on this computer. Ari works in place and never moves your files.
      </p>
      {projects.length >= FILTER_FROM && (
        <Input
          aria-label="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a project…"
          className="mt-4"
          leading={<Search size={14} strokeWidth={1.7} aria-hidden />}
        />
      )}
      {discovery === null ? (
        <div aria-label="Looking for recent projects" className="mt-5 space-y-1.5">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} h={52} className="rounded-lg" />
          ))}
        </div>
      ) : (
        <motion.ul
          aria-label="Projects"
          className="ari-scroll mt-5 flex max-h-[min(340px,42vh)] flex-col gap-0.5 overflow-y-auto"
          variants={staggerList(0.04)}
          initial={calm ? false : 'hidden'}
          animate="shown"
        >
          {visible.map((project) => {
            const key = projectPathKey(project.path)
            const checked = keys.has(key)
            const when = lastActive(project.lastUsedAt)
            const meta = [project.branch, when].filter(Boolean).join(' · ')
            return (
              <motion.li key={key} variants={listItem} layout="position">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`${project.name} (${project.path})`}
                  onClick={() => {
                    touched.current = true
                    onChange(
                      checked
                        ? selected.filter((p) => projectPathKey(p.path) !== key)
                        : [...selected, project],
                    )
                  }}
                  className={`ari-onboarding-row w-full ${checked ? 'is-selected' : ''}`}
                >
                  <span className="ari-onboarding-check" aria-hidden="true" />
                  <LetterTile name={project.name} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-fg">
                      {project.name}
                    </span>
                    <span
                      title={project.path}
                      className="mt-px block truncate font-mono text-[11.5px] text-fg-subtle"
                    >
                      {project.path}
                    </span>
                  </span>
                  {meta && <span className="shrink-0 text-[12px] text-fg-subtle">{meta}</span>}
                </button>
              </motion.li>
            )
          })}
          {visible.length === 0 && (
            <li className="px-3 py-4 text-[13px] text-fg-subtle">
              {needle
                ? 'No matching projects.'
                : 'No recent projects found. Choose a folder or start a new one.'}
            </li>
          )}
        </motion.ul>
      )}
      <div className="mt-1 flex flex-col gap-0.5">
        <button
          type="button"
          disabled={browsing}
          onClick={() => void browse()}
          className="ari-onboarding-row w-full text-[13.5px] text-fg-muted"
        >
          <span className="ari-onboarding-tile is-dashed" aria-hidden="true">
            <FolderPlus size={14} strokeWidth={1.7} />
          </span>
          {browsing ? 'Opening…' : 'Choose another folder…'}
        </button>
        <AnimatePresence initial={false} mode="popLayout">
          {creating === null ? (
            <motion.button
              key="new"
              type="button"
              onClick={() => setCreating('')}
              className="ari-onboarding-row w-full text-[13.5px] text-fg-muted"
              exit={{ opacity: 0 }}
            >
              <span className="ari-onboarding-tile is-dashed" aria-hidden="true">
                <Plus size={14} strokeWidth={1.7} />
              </span>
              Create a new project
            </motion.button>
          ) : (
            <motion.form
              key="form"
              initial={calm ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 px-3 py-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <Input
                autoFocus
                aria-label="New project name"
                placeholder="Project name"
                value={creating}
                onChange={(event) => setCreating(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setCreating(null)
                  }
                }}
                className="min-w-0 flex-1"
              />
              <Button size="sm" type="submit" disabled={creating.trim() === '' || saving}>
                {saving ? 'Creating…' : 'Create'}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setCreating(null)}>
                Cancel
              </Button>
            </motion.form>
          )}
        </AnimatePresence>
        {creating !== null && (
          <p className="px-3 text-[12px] text-fg-subtle">
            Makes an empty folder in your projects folder and starts a Git repository there.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-fg">
          <span className="ari-status mt-[5px]" data-status="error" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
        </p>
      )}
      {discovery?.truncated && (
        <p role="status" className="mt-2 px-3 text-[12px] text-fg-subtle">
          Showing a partial scan to keep setup fast.
        </p>
      )}
      <StepFooter
        onBack={onBack}
        primaryRef={primaryRef}
        primary={{
          label: count === 0 ? 'Skip for now' : `Add ${count} project${count === 1 ? '' : 's'}`,
          onClick: onContinue,
        }}
      />
    </div>
  )
}
