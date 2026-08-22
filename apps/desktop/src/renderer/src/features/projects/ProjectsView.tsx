import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Project } from '@ari/contracts/project'
import { Button } from '@ari/ui/button'
import { Field } from '@ari/ui/field'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import { Check, FolderPlus, Trash2, X } from 'lucide-react'
import { rpc } from '../../lib/rpc'

/** Degrees of accent hue rotation per project color index slot (8 slots). */
const HUE_STEP_DEG = 40

interface FormState {
  path: string
  name: string
}

const EMPTY_FORM: FormState = { path: '', name: '' }

interface ProjectCardProps {
  project: Project
  confirming: boolean
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}

function ProjectCard({
  project,
  confirming,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: ProjectCardProps) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{
              background: 'var(--ari-accent)',
              filter: `hue-rotate(${project.colorIndex * HUE_STEP_DEG}deg)`,
            }}
          />
          <span className="truncate text-sm font-medium text-fg">{project.name}</span>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-2xs text-fg-muted">Remove?</span>
            <IconButton
              size="sm"
              variant="danger"
              icon={<Check className="h-3.5 w-3.5" />}
              aria-label={`Confirm remove ${project.name}`}
              onClick={onConfirmRemove}
            />
            <IconButton
              size="sm"
              variant="ghost"
              icon={<X className="h-3.5 w-3.5" />}
              aria-label={`Keep ${project.name}`}
              onClick={onCancelRemove}
            />
          </div>
        ) : (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            aria-label={`Remove ${project.name}`}
            onClick={onAskRemove}
          />
        )}
      </div>
      <p className="truncate font-mono text-2xs text-fg-subtle">{project.path}</p>
    </li>
  )
}

/**
 * Projects manager (rail "Projects" destination, PLAN §6.1): grid of
 * registered workspace folders with add/remove flows over the `project.*`
 * RPC surface.
 */
export function ProjectsView() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setProjects(await rpc.invoke('project.list'))
  }

  useEffect(() => {
    refresh().catch(() => setProjects([]))
  }, [])

  const updateForm = (field: keyof FormState, value: string): void => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const closeForm = (): void => {
    setForm(EMPTY_FORM)
    setFormError(null)
    setFormOpen(false)
  }

  const handleAdd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const path = form.path.trim()
    if (path === '') {
      setFormError('Folder path is required.')
      return
    }
    const name = form.name.trim()
    void rpc
      .invoke('project.add', { path, name: name === '' ? undefined : name })
      .then((added) => {
        if (added === null) {
          setFormError(
            'Could not add that folder. Check the path exists and is not already registered.',
          )
          return
        }
        closeForm()
        return refresh()
      })
      .catch(() => {
        setFormError('Adding the project failed.')
      })
  }

  const handleRemove = (id: string): void => {
    void rpc
      .invoke('project.remove', { id })
      .then(() => {
        setConfirmingId(null)
        return refresh()
      })
      .catch(() => {
        setActionError('Removing the project failed.')
      })
  }

  return (
    <section aria-label="Projects" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-fg">Projects</h2>
        {!formOpen && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setActionError(null)
              setFormOpen(true)
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" /> Add project
          </Button>
        )}
      </div>

      {formOpen && (
        <form
          onSubmit={handleAdd}
          className="flex max-w-md flex-col gap-3 rounded-md border border-border bg-surface-1 p-3"
        >
          <h3 className="text-sm font-medium text-fg">Add project</h3>
          <Field label="Folder path" hint="Absolute path to the workspace folder.">
            {(controlProps) => (
              <Input
                {...controlProps}
                value={form.path}
                onChange={(event) => updateForm('path', event.target.value)}
                placeholder="/path/to/workspace"
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Name" hint="Optional; defaults to the folder name.">
            {(controlProps) => (
              <Input
                {...controlProps}
                value={form.name}
                onChange={(event) => updateForm('name', event.target.value)}
                placeholder="my-app"
                autoComplete="off"
              />
            )}
          </Field>
          {formError != null && (
            <p role="alert" className="text-xs text-danger">
              {formError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm">
              Add project
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {projects === null ? null : projects.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-fg-subtle">
          No projects yet.
          <br />
          Add one to get started.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              confirming={confirmingId === project.id}
              onAskRemove={() => {
                setActionError(null)
                setConfirmingId(project.id)
              }}
              onCancelRemove={() => setConfirmingId(null)}
              onConfirmRemove={() => handleRemove(project.id)}
            />
          ))}
        </ul>
      )}

      {actionError != null && (
        <p role="alert" className="text-xs text-danger">
          {actionError}
        </p>
      )}
    </section>
  )
}
