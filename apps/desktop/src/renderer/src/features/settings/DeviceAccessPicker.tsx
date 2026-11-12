interface Props {
  allowTerminal: boolean
  disabled: boolean
  onChange: (allowTerminal: boolean) => void
}

/** All projects are included; a host-user terminal needs its own explicit grant. */
export function DeviceAccessPicker({ allowTerminal, disabled, onChange }: Props) {
  return (
    <fieldset disabled={disabled} className="space-y-3 border-t border-border pt-3">
      <legend className="sr-only">Device access</legend>
      <div>
        <p className="text-sm font-medium">All projects on this computer</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          Includes projects you add later. This device can direct agents and answer approvals using
          their desktop permissions.
        </p>
      </div>
      <div className="border-t border-border pt-3">
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={allowTerminal}
            onChange={(event) => onChange(event.target.checked)}
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
  )
}
