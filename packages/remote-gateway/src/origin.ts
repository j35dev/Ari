/**
 * Origin handling for the remote gateway (ADR §5).
 *
 * The allowlist is exact: the whole origin string, scheme and port included,
 * compared against a fixed list. There is no pattern form and no wildcard —
 * a request either matches one of these strings or is refused, and the
 * refusal does not depend on anything the caller controls.
 */

/** Splits a comma-separated config value into origins, dropping blanks. */
export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/**
 * Whether a request may proceed from this `Origin`.
 *
 * An absent or empty origin is refused rather than treated as same-origin:
 * browsers always send `Origin` on a cross-origin request, so its absence
 * means a non-browser client — and a non-browser client must present a device
 * credential anyway, never inherit the trust a browser session would carry.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin.length === 0) return false
  const normalized = origin.toLowerCase()
  // `*` is refused even if an operator writes it into the config, because
  // accepting it here would silently disable the check rather than fail.
  if (normalized.includes('*')) return false
  return allowed.some((candidate) => candidate.toLowerCase() === normalized)
}

/**
 * Reads the origin a request claims, without trusting it for anything but the
 * allowlist check. Kept separate so callers cannot reach for the header
 * directly and skip the check.
 */
export function requestOrigin(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['origin'] ?? headers['Origin']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}
