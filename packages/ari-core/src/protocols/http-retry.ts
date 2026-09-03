/**
 * Retry layer shared by every Ari Core streaming transport.
 *
 * A model endpoint — especially a gateway fronting another provider — answers
 * a healthy request with 500/502/529 often enough that a harness without
 * backoff reads as broken. Retrying is only safe before the first byte of the
 * stream reaches the caller, so this wraps the *connection attempt* alone: a
 * failure mid-stream has already emitted content and is the client's problem.
 */

/** What a streaming transport resolves to, success or failure. */
export interface StreamResponse {
  /** Live line stream on success; null when the attempt failed. */
  body: AsyncIterable<string> | null
  status: number
  statusText: string
  /** Response text of a failed attempt — the endpoint's own error message. */
  errorBody?: string | null
  /** `Retry-After` header, when the endpoint sent one. */
  retryAfter?: string | null
  /** Attempts spent reaching this response, including the first. */
  attempts?: number
}

export type StreamFetch = (url: string, init: RequestInit) => Promise<StreamResponse>

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  maxAttempts: number
  /** Delay before the second attempt; doubles from there. */
  baseDelayMs: number
  /** Ceiling for one delay, and for any `Retry-After` the endpoint asks for. */
  maxDelayMs: number
}

/**
 * Four retries spread over roughly eight seconds. Sized against what actually
 * fails: a gateway blip clears within a second, while an upstream throttle
 * needs seconds — and a turn cannot afford to wait out a full `Retry-After`
 * minute, so {@link RetryPolicy.maxDelayMs} caps that too.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
}

/**
 * Statuses worth another attempt: transport-level congestion and upstream
 * faults. Everything else (400/401/403/404/422) describes the request itself,
 * where a retry only wastes the user's time and quota. 529 is Anthropic's
 * "overloaded"; 425 and 408 are timing, not content.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504, 529])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

/** `Retry-After` as milliseconds; accepts delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/**
 * Delay before the attempt following `attempt` (1-based). Exponential from
 * {@link RetryPolicy.baseDelayMs}, capped, with equal jitter — half the delay
 * fixed, half random — so concurrent turns spread out without any of them
 * retrying instantly, which is what makes a burst of failures look like one.
 * An endpoint's own `Retry-After` wins, still capped.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxDelayMs)
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs)
  return Math.round(exponential / 2 + random() * (exponential / 2))
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Readable text for a thrown value of unknown shape. `String(error)` on a
 * non-Error object yields `[object Object]`, which tells a user nothing about
 * why their turn died.
 */
export function faultMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  return 'unknown error'
}

export interface RetryDeps {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

/**
 * Wraps a single-attempt transport in {@link DEFAULT_RETRY_POLICY} backoff.
 * The returned response carries `attempts` so a caller can say how hard it
 * tried. An aborted signal ends the sequence immediately — an interrupt must
 * not wait out a backoff — and a thrown network error is retried like a 502,
 * rethrown only once the attempts run out.
 */
export function withRetry(
  attemptOnce: StreamFetch,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: RetryDeps = {},
): StreamFetch {
  const nap = deps.sleep ?? sleep
  const random = deps.random ?? Math.random
  return async (url, init) => {
    const signal = init.signal instanceof AbortSignal ? init.signal : undefined
    let thrown: unknown = null
    for (let attempt = 1; ; attempt++) {
      let response: StreamResponse | null = null
      try {
        response = await attemptOnce(url, init)
      } catch (error) {
        // An abort is the user's decision, not a fault to retry.
        if (signal?.aborted === true) throw error
        thrown = error
      }
      if (response !== null && !isRetryableStatus(response.status)) {
        return { ...response, attempts: attempt }
      }
      const exhausted = attempt >= policy.maxAttempts
      if (!exhausted && signal?.aborted !== true) {
        await nap(
          backoffDelayMs(attempt, policy, parseRetryAfter(response?.retryAfter), random),
          signal,
        )
      }
      // Checked again after the wait: an interrupt during backoff ends the
      // sequence rather than spending one more attempt on cancelled work.
      if (exhausted || signal?.aborted === true) {
        if (response !== null) return { ...response, attempts: attempt }
        throw thrown
      }
    }
  }
}

/** Longest error body kept for diagnostics; a failing gateway can return a page. */
export const MAX_ERROR_BODY_CHARS = 2000

/**
 * Relays a stream's lines, reporting a mid-stream fault through `onError`
 * instead of throwing. A transport error after the first byte cannot be
 * retried — content is already out — but it must not escape a client
 * generator either: unhandled, it tears down the turn with a raw rejection
 * instead of a legible failure.
 */
export async function* guardStream(
  body: AsyncIterable<string>,
  onError: (error: unknown) => void,
): AsyncGenerator<string> {
  try {
    for await (const line of body) yield line
  } catch (error) {
    onError(error)
  }
}

/**
 * Silence allowed between two lines before a stream counts as stalled.
 *
 * Generous on purpose: a reasoning model behind a buffering gateway can take a
 * long time to produce its first token, and killing a turn that was about to
 * answer is worse than waiting. What this catches is the opposite failure — a
 * gateway that accepted the connection and then went away, which otherwise
 * hangs the turn until the user notices and interrupts it by hand.
 */
export const DEFAULT_STREAM_IDLE_MS = 120_000

/**
 * Wraps a line stream so a gap longer than `idleMs` ends it with a stall error
 * instead of waiting forever. The underlying iterator is closed on the way out,
 * so an abandoned socket does not outlive the turn. Raising past the first line
 * is deliberate: the fault reaches the client's mid-stream handler, which keeps
 * whatever content already arrived.
 */
export async function* withIdleDeadline(
  body: AsyncIterable<string>,
  idleMs: number = DEFAULT_STREAM_IDLE_MS,
): AsyncGenerator<string> {
  const iterator = body[Symbol.asyncIterator]()
  const stalled = Symbol('stalled')
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<typeof stalled>((resolve) => {
      timer = setTimeout(() => resolve(stalled), idleMs)
    })
    let settled: IteratorResult<string> | typeof stalled
    try {
      settled = await Promise.race([iterator.next(), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (settled === stalled) {
      await iterator.return?.()
      throw new Error(`endpoint sent nothing for ${Math.max(1, Math.round(idleMs / 1000))}s`)
    }
    if (settled.done === true) return
    yield settled.value
  }
}

/** Longest error body inlined into a user-facing message. */
const MAX_ERROR_SUMMARY_CHARS = 300

/** Collapses an error body to one readable line, or null when it says nothing. */
export function summarizeErrorBody(
  body: string | null | undefined,
  max = MAX_ERROR_SUMMARY_CHARS,
): string | null {
  if (body === null || body === undefined) return null
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Phrases endpoints use when a request outgrew the model's context. The status
 * is an ordinary 400, so without this the failure reads as a generic bad
 * request and the user is never told that the fix is a shorter conversation.
 */
const CONTEXT_OVERFLOW =
  /context[ _-]?length|context[ _-]?window|maximum context|too many (?:input )?tokens|prompt is too long|reduce the length/i

/** True when a rejected request was too long rather than malformed. */
export function isContextOverflow(response: StreamResponse): boolean {
  if (![400, 413, 422].includes(response.status)) return false
  return CONTEXT_OVERFLOW.test(response.errorBody ?? '')
}

/**
 * The message a failed attempt sequence reaches the user with. Names the
 * status, how many attempts were spent, and whatever the endpoint said —
 * without which a gateway's own explanation is invisible and every failure
 * reads identically. A context overflow leads with what to do about it, since
 * the status alone points at the request being malformed instead of long.
 */
export function describeFailure(response: StreamResponse): string {
  const attempts = response.attempts ?? 1
  const tried = attempts > 1 ? ` (${attempts} attempts)` : ''
  const detail = summarizeErrorBody(response.errorBody)
  const head = isContextOverflow(response)
    ? `endpoint error ${response.status}: the conversation is longer than this model's context ` +
      'window — start a new session, or pick a model with a larger window'
    : `endpoint error ${response.status}: ${response.statusText}${tried}`
  return detail === null ? head : `${head} — ${detail}`
}
