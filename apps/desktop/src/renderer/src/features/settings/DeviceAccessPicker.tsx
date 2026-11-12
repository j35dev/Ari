import type { Project } from '@ari/contracts/project'
import { quietButton } from '../../lib/recipes'

interface Props {
  projects: readonly Project[]
  projectIds: readonly string[]
  allowTerminal: boolean
  disabled: boolean
  onChange: (projectIds: string[], allowTerminal: boolean) => void
}

/**
 * Project and terminal grants, shared by device approval and editing so a
 * paired phone is changed with exactly the choices it was approved with.
 * Same-named projects show their path, because a name alone cannot tell two
 * clones of one repository apart.
 */
export function DeviceAccessPicker({
  projects,
  projectIds,
  allowTerminal,
  disabled,
  onChange,
}: Props) {
  const names = projects.map((project) => project.name)
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="sr-only">Choose access</legend>
      <div className="border-t border-border pt-3">
        <p className="text-sm font-medium text-fg">Projects this device may reach</p>
        <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
          Choose its access. Nothing is selected automatically.
        </p>
        {projects.length > 1 ? (
          <div className="-ml-2 mt-1 flex gap-1">
            <button
              type="button"
              onClick={() =>
                onChange(
                  projects.map((project) => project.id),
                  allowTerminal,
                )
              }
              className={quietButton}
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => onChange([], allowTerminal)}
              className={quietButton}
            >
              Select none
            </button>
          </div>
        ) : null}
        {projects.length === 0 ? (
          <p className="py-3 text-[13px] text-fg-subtle">No projects are registered yet.</p>
        ) : (
          projects.map((project) => (
            <label key={project.id} className="flex min-h-10 items-center gap-3 text-sm text-fg">
              <input
                type="checkbox"
                checked={projectIds.includes(project.id)}
                aria-label={project.name}
                onChange={(event) => {
                  const checked = event.target.checked
                  onChange(
                    checked
                      ? [...projectIds, project.id]
                      : projectIds.filter((id) => id !== project.id),
                    allowTerminal,
                  )
                }}
                className="size-4 shrink-0 accent-fg"
              />
              <span className="min-w-0">
                <span className="block">{project.name}</span>
                {names.indexOf(project.name) !== names.lastIndexOf(project.name) ? (
                  <span className="block truncate font-mono text-xs text-fg-subtle">
                    {project.path}
                  </span>
                ) : null}
              </span>
            </label>
          ))
        )}
      </div>
      <div className="border-t border-border pt-3">
        <label className="flex min-h-10 items-center gap-3 text-sm text-fg">
          <input
            type="checkbox"
            checked={allowTerminal}
            onChange={(event) => onChange([...projectIds], event.target.checked)}
            className="size-4 accent-fg"
          />
          Allow terminal access
        </label>
        <p className="text-[13px] leading-5 text-fg-subtle">
          A shell runs with this computer&apos;s user permissions; a project folder is not a
          sandbox.
        </p>
      </div>
    </fieldset>
  )
}
