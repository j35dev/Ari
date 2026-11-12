import { useState } from 'react'
import type { RemoteState } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { DeviceAccessPicker } from './DeviceAccessPicker'

interface Props {
  pending: NonNullable<RemoteState['pending']>
  disabled: boolean
  expired: boolean
  approve: (allowTerminal: boolean) => void
  deny: () => void
}

/** Requires a matching device code and separate terminal grant for each invitation. */
export function RemotePairingApproval({ pending, disabled, expired, approve, deny }: Props) {
  const [verified, setVerified] = useState(false)
  const [allowTerminal, setAllowTerminal] = useState(false)
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
        {pending.displayName} asked to pair. This code must match the one on the device&apos;s
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
        <legend className="sr-only">Verify device</legend>
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
          allowTerminal={allowTerminal}
          disabled={false}
          onChange={setAllowTerminal}
        />
      </fieldset>
      <p className="my-3 text-[13px] leading-5 text-fg-subtle">
        Approve only a phone or computer you recognize. You can revoke its access here at any time.
      </p>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={disabled || expired || !verified}
          onClick={() => approve(allowTerminal)}
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
