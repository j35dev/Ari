import { useState } from 'react'
import type { Project } from '@ari/contracts/project'
import type { RemoteState } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'

interface Props {
  pending: NonNullable<RemoteState['pending']>
  projects: Project[]
  disabled: boolean
  expired: boolean
  approve: (projectIds: string[], allowTerminal: boolean) => void
  deny: () => void
}

/** Requires a matching phone code and an explicit project grant for each invitation. */
export function RemotePairingApproval({
  pending,
  projects,
  disabled,
  expired,
  approve,
  deny,
}: Props) {
  const [granted, setGranted] = useState<string[]>([])
  const [verified, setVerified] = useState(false)
  const [allowTerminal, setAllowTerminal] = useState(false)
  const projectIds = granted.filter((id) => projects.some((project) => project.id === id))
  return (
    <section
      aria-labelledby="remote-pending-heading"
      className="rounded-xl border border-accent/40 bg-surface-1 p-5"
    >
      <p className="mb-2 text-xs font-medium text-accent">Confirm on this computer</p>
      <h2 id="remote-pending-heading" className="text-base font-semibold">
        A device wants to connect
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-fg-muted">
        {pending.displayName} asked to pair. This code must match the one on the phone&apos;s
        screen.
      </p>
      <p
        aria-label="Confirmation code"
        className="my-4 font-mono text-2xl tracking-[0.2em] text-fg"
      >
        {pending.confirmationCode}
      </p>
      {expired ? (
        <p role="alert" className="text-sm text-danger">
          This request expired. Start a new invitation.
        </p>
      ) : null}
      <fieldset disabled={disabled || expired} className="space-y-3">
        <legend className="sr-only">Verify device and choose access</legend>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={verified}
            onChange={(event) => setVerified(event.target.checked)}
            className="size-4 accent-accent"
          />
          The codes match
        </label>
        <div className="border-t border-border pt-3">
          <p className="text-sm font-medium">Projects this device may reach</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Choose its access. Nothing is selected automatically.
          </p>
          {projects.length > 1 ? (
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setGranted(projects.map((project) => project.id))}
                className="min-h-11 text-xs text-fg-muted underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setGranted([])}
                className="min-h-11 text-xs text-fg-muted underline"
              >
                Select none
              </button>
            </div>
          ) : null}
          {projects.length === 0 ? (
            <p className="py-3 text-sm text-fg-muted">No projects are registered yet.</p>
          ) : (
            projects.map((project) => (
              <label key={project.id} className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={projectIds.includes(project.id)}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setGranted((current) =>
                      checked
                        ? [...current, project.id]
                        : current.filter((id) => id !== project.id),
                    )
                  }}
                  className="size-4 accent-accent"
                />
                {project.name}
              </label>
            ))
          )}
        </div>
        <div className="border-t border-border pt-3">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={allowTerminal}
              onChange={(event) => setAllowTerminal(event.target.checked)}
              className="size-4 accent-accent"
            />
            Allow terminal access
          </label>
          <p className="text-xs leading-relaxed text-fg-muted">
            A shell runs with this computer&apos;s user permissions; a project folder is not a
            sandbox.
          </p>
        </div>
      </fieldset>
      <p className="my-3 text-xs leading-relaxed text-fg-muted">
        This device can direct agents and answer approvals in the selected projects. Agents use
        their desktop permissions.
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={disabled || expired || !verified || projectIds.length === 0}
          onClick={() => approve(projectIds, allowTerminal)}
          className="min-h-11"
        >
          Approve
        </Button>
        <Button disabled={disabled} onClick={deny} className="min-h-11">
          Deny
        </Button>
      </div>
    </section>
  )
}
