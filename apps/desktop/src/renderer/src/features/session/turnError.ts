/**
 * Turns raw agent failure text into a short headline plus an actionable hint.
 * The engine already decodes the deep failure modes (npm exit codes, handshake
 * timeouts, ACP stalls) into legible prose; this layer pattern-matches that
 * prose into the few families users actually act on. Anything unmatched falls
 * through with no hint — the raw message is shown verbatim instead.
 */

export interface TurnErrorView {
  /** Short family headline, e.g. "Authentication required". */
  title: string
  /** What to do about it; null when the family has no canned advice. */
  hint: string | null
}

/** Ordered families — the first match wins. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [
    // Deliberately excludes the bare word "login": the ACP stall watchdog's
    // message ends "…may be wedged or waiting for login", and that is a stall
    // failure, not an auth one — matching it here used to relabel wedged
    // agents as "Authentication required" and send users to a terminal for
    // a login they did not need.
    /not authenticated|unauthorized|401|invalid api key|invalid apikey|api key|apikey|oauth|login flow|sign in/i,
    'Authentication required',
    'Run the agent’s login flow once in a terminal, then retry.',
  ],
  [
    /rate limit|429|quota|billing|credit|too many requests|overloaded|capacity|529/i,
    'Provider is throttling',
    'The provider is rate-limiting or out of quota — wait a moment or check your plan’s billing, then retry.',
  ],
  [
    /enoent|is not recognized|command not found|no such file|cannot find|spawn.*fail|not a valid win32/i,
    'Agent could not start',
    'The CLI may not be installed or is missing from PATH — install it and confirm it runs in a terminal, then retry.',
  ],
  [
    // "went silent" is the stall watchdog's exact phrasing; "waiting for
    // login" in its message must land here, not in the auth family above.
    /timed? ?out|no output within|went silent|stall|wedged|handshake/i,
    'Agent timed out',
    'The agent stopped responding — it may be waiting for login or a hung process. Retry once it responds in a terminal.',
  ],
  [
    /econnrefused|enotfound|econnreset|getaddrinfo|network|fetch failed/i,
    'Network error',
    'Ari could not reach the provider — check your connection or proxy settings, then retry.',
  ],
]

const FALLBACK: TurnErrorView = { title: 'Turn failed', hint: null }

/** Classifies one raw failure message into a headline + hint. */
export function classifyTurnError(message: string): TurnErrorView {
  for (const [pattern, title, hint] of PATTERNS) {
    if (pattern.test(message)) return { title, hint }
  }
  return FALLBACK
}
