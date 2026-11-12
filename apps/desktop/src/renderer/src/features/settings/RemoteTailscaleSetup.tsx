import { useState } from 'react'
import { Button } from '@ari/ui/button'
import type { z } from 'zod'
import type { rpcParams, TailscaleServeMapping, TailscaleState } from '@ari/contracts/rpc'

type TailscaleEnableOptions = z.input<(typeof rpcParams)['remote.tailscale.enable']>

interface Props {
  state: TailscaleState | null
  enabled: boolean
  disabled: boolean
  enable: (options?: TailscaleEnableOptions) => void
  disable: () => void
  refresh: () => void
}

/** Presents exact observed mappings. Only an explicit confirmation replaces a foreign root. */
export function RemoteTailscaleSetup({
  state,
  enabled,
  disabled,
  enable,
  disable,
  refresh,
}: Props) {
  const [replacement, setReplacement] = useState<TailscaleServeMapping | null>(null)
  const [leftUnchanged, setLeftUnchanged] = useState(false)
  const conflicts = state?.conflicts ?? []
  const canServe = enabled && state?.installed === true && state.origin !== null
  const suggestion = state?.suggestedHttpsPort
  const hasSuggestion = typeof suggestion === 'number'
  const owned = state?.owned === true
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">{state?.error ?? summary(state)}</p>
      {state?.installed === false ? (
        <p className="text-[13px] leading-5 text-fg-subtle">
          Install Tailscale on this computer and your other devices. Sign them into the same
          network.
        </p>
      ) : state?.origin === null ? (
        <p className="text-[13px] leading-5 text-fg-subtle">
          Open Tailscale on this computer and sign in, then check again.
        </p>
      ) : (
        <p className="text-[13px] leading-5 text-fg-subtle">
          Connect your other devices to the same Tailscale network to open Ari.
        </p>
      )}
      {conflicts.length > 0 ? (
        <section
          aria-label="Existing Tailscale addresses"
          className="rounded-xl border border-border bg-surface-1 px-4 py-3"
        >
          <p className="text-sm font-medium text-fg">
            {owned ? 'Other services share this address' : 'An address is already in use'}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
            {owned
              ? 'Repair Ari on its saved port. These services stay available.'
              : 'Use another port to keep these services available. Review a root replacement only if you want Ari to take its address.'}
          </p>
          <ul className="mt-2 divide-y divide-border">
            {conflicts.map((conflict, index) => (
              <li
                key={`${conflict.origin}:${conflict.mountPath}:${index}`}
                className="space-y-2 py-3"
              >
                <p className="break-all text-sm">
                  {conflict.origin}
                  {conflict.mountPath ?? ''}
                </p>
                <p className="break-all font-mono text-xs text-fg-subtle">{conflict.target}</p>
                <p className="text-xs text-fg-subtle">
                  {conflict.listening === true
                    ? 'Service is listening'
                    : conflict.listening === false
                      ? 'Service is not listening'
                      : 'Service status is unknown'}
                </p>
                {conflict.mountPath === '/' && conflict.kind !== 'tcp' ? (
                  <Button
                    variant="ghost"
                    disabled={!canServe || disabled}
                    onClick={() => {
                      setReplacement(conflict)
                      setLeftUnchanged(false)
                    }}

                    aria-label={`Review replacement at ${conflict.origin}`}
                  >
                    Replace this address…
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {replacement !== null ? (
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-sm font-medium text-fg">
                Replace the service at {replacement.origin}?
              </p>
              <p className="break-all text-[13px] leading-5 text-fg-subtle">
                Ari will replace the root mapping to {replacement.target}. Other mounts stay
                available. If this mapping changes before you confirm, Ari will ask you to check
                again.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  disabled={!canServe || disabled}
                  onClick={() => {
                    if (replacement.kind === 'tcp') return
                    enable({
                      replace: {
                        origin: replacement.origin,
                        mountPath: '/',
                        target: replacement.target,
                        kind: replacement.kind,
                      },
                    })
                    setReplacement(null)
                  }}
                >
                  Confirm replacement
                </Button>
                <Button variant="ghost" disabled={disabled} onClick={() => setReplacement(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state?.serving === true ? (
          <Button disabled={disabled} onClick={disable}>
            Stop serving Ari
          </Button>
        ) : owned ? (
          <>
            <Button
              disabled={!canServe || disabled}
              onClick={() => {
                setLeftUnchanged(false)
                enable()
              }}
            >
              Repair Ari connection
            </Button>
            <Button variant="ghost" disabled={disabled} onClick={disable}>
              Remove Ari mapping
            </Button>
            {hasSuggestion && suggestion !== state?.httpsPort ? (
              <Button
                variant="ghost"
                disabled={!canServe || disabled}
                onClick={() => enable({ httpsPort: suggestion })}
              >
                Use new address on port {suggestion}
              </Button>
            ) : null}
          </>
        ) : (
          <Button
            disabled={!canServe || disabled || (conflicts.length > 0 && !hasSuggestion)}
            onClick={() => {
              setLeftUnchanged(false)
              enable(hasSuggestion ? { httpsPort: suggestion } : undefined)
            }}
          >
            {conflicts.length > 0 && hasSuggestion
              ? `Use port ${suggestion}`
              : 'Serve Ari over Tailscale'}
          </Button>
        )}
        {conflicts.length > 0 ? (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setReplacement(null)
              setLeftUnchanged(true)
            }}
          >
            Leave unchanged
          </Button>
        ) : null}
        <Button variant="ghost" disabled={disabled} onClick={refresh}>
          Check connection
        </Button>
      </div>
      {leftUnchanged ? (
        <p role="status" className="text-[13px] text-fg-subtle">
          Existing services are unchanged. Choose a connection when you are ready.
        </p>
      ) : null}
    </div>
  )
}

function summary(state: TailscaleState | null): string {
  if (state === null) return 'Checking Tailscale…'
  if (!state.installed) return 'Tailscale is not installed on this computer.'
  if (state.origin === null) return 'This computer is not connected to a Tailscale network yet.'
  if (state.serving) return `Ari is available at ${state.origin}.`
  if (state.owned) return 'Ari has a saved address, but its connection needs repair.'
  return 'Tailscale is connected. Choose an address for Ari.'
}
