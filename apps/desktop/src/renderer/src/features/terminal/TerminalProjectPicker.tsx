import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, FolderOpen, Plus, Search } from 'lucide-react'
import type { Project } from '@ari/contracts/project'
import { Popover } from '@ari/ui/popover'

export function TerminalProjectPicker({
  projects,
  value,
  onChange,
  onAddProject,
}: {
  projects: readonly Project[]
  value: string | null
  onChange: (id: string) => void
  onAddProject: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const panelId = useId()
  const selected = projects.find((project) => project.id === value)
  const needle = query.trim().toLowerCase().replaceAll('\\', '/')
  const matches = projects.filter((project) =>
    `${project.name} ${project.path.replaceAll('\\', '/')}`.toLowerCase().includes(needle),
  )
  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (!next) setQuery('')
  }

  useEffect(() => {
    if (open) search.current?.focus()
  }, [open])

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Popover.Trigger
        className="ari-terminal-project-picker"
        aria-label="Terminal project"
        aria-haspopup="dialog"
        aria-controls={panelId}
        title={selected ? `${selected.name} · ${selected.path}` : 'Choose a project'}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            changeOpen(true)
          }
        }}
      >
        <FolderOpen size={14} aria-hidden />
        <span>{selected?.name ?? 'Choose project'}</span>
        <ChevronDown size={11} aria-hidden className={open ? 'is-open' : undefined} />
      </Popover.Trigger>
      <Popover.Content
        id={panelId}
        side="bottom"
        align="start"
        sideOffset={6}
        aria-label="Choose terminal project"
        className="ari-terminal-project-menu"
        onKeyDown={(event) => {
          if (!matches.length) return
          const index = options.current.findIndex((option) => option === document.activeElement)
          let next: number | undefined
          if (event.key === 'ArrowDown') next = (index + 1) % matches.length
          if (event.key === 'ArrowUp')
            next = index < 0 ? matches.length - 1 : (index - 1 + matches.length) % matches.length
          if (index >= 0 && event.key === 'Home') next = 0
          if (index >= 0 && event.key === 'End') next = matches.length - 1
          if (next !== undefined) {
            event.preventDefault()
            event.stopPropagation()
            options.current[next]?.focus()
          }
        }}
      >
        <label className="ari-terminal-project-filter">
          <Search size={13} aria-hidden />
          <input
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Find terminal project"
            placeholder="Find a project…"
          />
        </label>
        <div className="ari-terminal-project-options" role="listbox" aria-label="Terminal projects">
          {matches.map((project, index) => (
            <button
              key={project.id}
              ref={(element) => {
                options.current[index] = element
              }}
              type="button"
              role="option"
              aria-selected={project.id === value}
              aria-label={`${project.name} · ${project.path.replaceAll('\\', '/')}${project.status === 'missing' ? ' · Folder unavailable' : ''}`}
              className="ari-terminal-project-option"
              title={project.path}
              onClick={() => {
                onChange(project.id)
                changeOpen(false)
              }}
            >
              <FolderOpen size={14} aria-hidden />
              <span className="ari-terminal-project-copy">
                <strong>{project.name}</strong>
                <span>{project.path.replaceAll('\\', '/')}</span>
                {project.status === 'missing' && <small>Folder unavailable</small>}
              </span>
              {project.id === value && <Check size={13} aria-hidden />}
            </button>
          ))}
          {!matches.length && (
            <p className="ari-terminal-project-empty">
              {projects.length ? 'No matching projects.' : 'Add a project to open terminals.'}
            </p>
          )}
        </div>
        <button
          type="button"
          className="ari-terminal-project-add"
          onClick={() => {
            changeOpen(false)
            onAddProject()
          }}
        >
          <Plus size={13} aria-hidden />
          Add project
        </button>
      </Popover.Content>
    </Popover>
  )
}
