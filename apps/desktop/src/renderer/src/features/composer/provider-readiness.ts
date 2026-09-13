/**
 * The detection fields the rail gate reads. Structural rather than the full
 * `Detection`, because the renderer receives these over RPC with `kind` and
 * `authStatus` widened to `string`; a generic keeps both call sites typed.
 */
export interface ProviderReadiness {
  kind: string
  installed: boolean
  authStatus: string
  authReason?: string | undefined
}

/** A provider the rail will not offer, paired with why. */
export interface WithheldProvider<T> {
  detection: T
  /** Sentence for the picker's "not shown" note; names no provider itself. */
  reason: string
}

export interface ProviderPartition<T> {
  /** Providers the rail offers: installed and not known to be logged out. */
  ready: T[]
  /** Detected-but-unusable providers, so the picker can say where one went. */
  withheld: WithheldProvider<T>[]
}

/**
 * Splits detections into the providers the picker may offer and those it must
 * withhold, so the rail never advertises a harness the user cannot run a turn
 * on. Two conditions, deliberately different in kind:
 *
 * - `installed` — a real binary resolved on disk. A provider that is absent
 *   still gets a fully-populated catalog from `providers.models` (catalogs are
 *   fetched per kind, not per machine), so the rail has to gate on this or an
 *   uninstalled harness renders as a working one.
 * - `authStatus !== 'unauthenticated'` — only `unauthenticated` withholds.
 *   `unknown` means Ari found no credential store but the CLI may authenticate
 *   another way (`ANTHROPIC_API_KEY`, a subscription session); hiding those
 *   would drop providers that work fine.
 *
 * `ari-core` is Ari's own runtime and has no binary to find, so it is always
 * offered regardless of what the probe reported.
 */
export function partitionProviders<T extends ProviderReadiness>(
  detections: readonly T[],
): ProviderPartition<T> {
  const ready: T[] = []
  const withheld: WithheldProvider<T>[] = []
  for (const detection of detections) {
    if (detection.kind !== 'ari-core' && !detection.installed) {
      withheld.push({ detection, reason: 'Not installed - no CLI found on PATH.' })
      continue
    }
    if (detection.authStatus === 'unauthenticated') {
      withheld.push({ detection, reason: unauthenticatedReason(detection) })
      continue
    }
    ready.push(detection)
  }
  return { ready, withheld }
}

function unauthenticatedReason(detection: ProviderReadiness): string {
  return detection.authReason ?? 'Not signed in - run the CLI once to authenticate.'
}
