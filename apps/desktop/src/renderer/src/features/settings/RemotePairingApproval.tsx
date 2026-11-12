import { useState } from 'react'
import type { Project } from '@ari/contracts/project'
import type { RemoteState } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { DeviceAccessPicker } from './DeviceAccessPicker'

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
      className="rounded-xl border border-border-strong bg-surface-1 px-4 py-3.5"
    >
      <p className="mb-2 flex items-center gap-2 text-[13px] text-accent">
        <span className="ari-status" data-status="attention" aria-hidden="true" />
        Confirm on this computer
      </p>
      <h2 id="remote-pending-heading" className="text-sm font-medium text-fg">
        A device wants to connect
      </h2>
      <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
        {pending.displayName} asked to pair. This code must match the one on the phone&apos;s
        screen.
      </p>
      <p aria-label="Confirmation code" className="my-4 font-mono text-2xl text-fg">
        {pending.confirmationCode}
      </p>
      {expired ? (
        <p role="alert" className="mb-2 text-[13px] text-danger">
          This request expired. Start a new invitation.
        </p>
      ) : null}
      <fieldset disabled={disabled || expired} className="space-y-3">
        <legend className="sr-only">Verify device and choose access</legend>
        <label className="flex min-h-10 items-center gap-3 text-sm text-fg">
          <input
            type="checkbox"
            checked={verified}
            onChange={(event) => setVerified(event.target.checked)}
            className="size-4 accent-fg"
          />
          The codes match
        </label>
        <DeviceAccessPicker
          projects={projects}
          projectIds={granted}
          allowTerminal={allowTerminal}
          disabled={false}
          onChange={(nextProjectIds, nextAllowTerminal) => {
            setGranted(nextProjectIds)
            setAllowTerminal(nextAllowTerminal)
          }}
        />
      </fieldset>
      <p className="my-3 text-[13px] leading-5 text-fg-subtle">
        This device can direct agents and answer approvals in the selected projects. Agents use
        their desktop permissions.
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={disabled || expired || !verified || projectIds.length === 0}
          onClick={() => approve(projectIds, allowTerminal)}
        >
          Approve
        </Button>
        <Button disabled={disabled} onClick={deny}>
          Deny
        </Button>
      </div>
    </section>
  )
}
