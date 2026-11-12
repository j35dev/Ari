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
        <p className="text-sm font-medium text-fg">All projects on this computer</p>
        <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
          Includes projects you add later. This device can direct agents and answer approvals using
          their desktop permissions.
        </p>
      </div>
      <div className="border-t border-border pt-3">
        <label className="flex min-h-10 items-center gap-3 text-sm text-fg">
          <input
            type="checkbox"
            checked={allowTerminal}
            onChange={(event) => onChange(event.target.checked)}
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
