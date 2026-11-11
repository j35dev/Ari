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
export function RemoteTailscaleSetup({ state, enabled, disabled, enable, disable, refresh }: Props) {
  const [replacement, setReplacement] = useState<TailscaleServeMapping | null>(null)
  const [leftUnchanged, setLeftUnchanged] = useState(false)
  const conflicts = state?.conflicts ?? []
  const canServe = enabled && state?.installed === true && state.origin !== null
  const suggestion = state?.suggestedHttpsPort
  const hasSuggestion = typeof suggestion === 'number'
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-fg-muted">{state?.error ?? summary(state)}</p>
      {state?.installed === false ? (
        <p className="text-xs leading-relaxed text-fg-muted">
          Install Tailscale on this computer and your other devices. Sign them into the same network.
        </p>
      ) : state?.origin === null ? (
        <p className="text-xs leading-relaxed text-fg-muted">
          Open Tailscale on this computer and sign in, then check again.
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-fg-muted">
          Connect your other devices to the same Tailscale network to open Ari.
        </p>
      )}
      {conflicts.length > 0 ? (
        <section aria-label="Existing Tailscale addresses" className="rounded-lg bg-surface-2/60 p-3">
          <p className="text-sm font-medium">An address is already in use</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Use another port to keep the existing service available, or review a replacement below.
          </p>
          <ul className="mt-2 divide-y divide-border">
            {conflicts.map((conflict, index) => (
              <li key={`${conflict.origin}:${conflict.mountPath}:${index}`} className="space-y-2 py-3">
                <p className="break-all text-sm">{conflict.origin}{conflict.mountPath ?? ''}</p>
                <p className="break-all font-mono text-xs text-fg-muted">{conflict.target}</p>
                <p className="text-xs text-fg-subtle">
                  {conflict.listening === true ? 'Service is listening' : conflict.listening === false ? 'Service is not listening' : 'Service status is unknown'}
                </p>
                {conflict.mountPath === '/' && conflict.kind !== 'tcp' ? (
                  <Button
                    variant="ghost"
                    disabled={!canServe || disabled}
                    onClick={() => { setReplacement(conflict); setLeftUnchanged(false) }}
                    className="min-h-11"
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
              <p className="text-sm font-medium">Replace the service at {replacement.origin}?</p>
              <p className="break-all text-xs leading-relaxed text-fg-muted">
                Ari will replace the root mapping to {replacement.target}. Other mounts stay available.
                If this mapping changes before you confirm, Ari will ask you to check again.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  disabled={!canServe || disabled}
                  onClick={() => {
                    if (replacement.kind === 'tcp') return
                    enable({ replace: { origin: replacement.origin, mountPath: '/', target: replacement.target, kind: replacement.kind } })
                    setReplacement(null)
                  }}
                  className="min-h-11"
                >Confirm replacement</Button>
                <Button variant="ghost" disabled={disabled} onClick={() => setReplacement(null)} className="min-h-11">Cancel</Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state?.serving === true ? (
          <Button disabled={disabled} onClick={disable} className="min-h-11">Stop serving Ari</Button>
        ) : (
          <Button
            disabled={!canServe || disabled || (conflicts.length > 0 && !hasSuggestion)}
            onClick={() => { setLeftUnchanged(false); enable(hasSuggestion ? { httpsPort: suggestion } : undefined) }}
            className="min-h-11"
          >{conflicts.length > 0 && hasSuggestion ? `Use port ${suggestion}` : 'Serve Ari over Tailscale'}</Button>
        )}
        {conflicts.length > 0 ? (
          <Button variant="ghost" disabled={disabled} onClick={() => { setReplacement(null); setLeftUnchanged(true) }} className="min-h-11">Leave unchanged</Button>
        ) : null}
        <Button variant="ghost" disabled={disabled} onClick={refresh} className="min-h-11">Check connection</Button>
      </div>
      {leftUnchanged ? <p role="status" className="text-xs text-fg-muted">Existing services are unchanged. Choose a connection when you are ready.</p> : null}
    </div>
  )
}

function summary(state: TailscaleState | null): string {
  if (state === null) return 'Checking Tailscale…'
  if (!state.installed) return 'Tailscale is not installed on this computer.'
  if (state.origin === null) return 'This computer is not connected to a Tailscale network yet.'
  if (state.serving) return `Ari is available at ${state.origin}.`
  return 'Tailscale is connected. Choose an address for Ari.'
}
