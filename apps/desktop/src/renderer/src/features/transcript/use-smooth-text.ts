import { useEffect, useRef, useState } from 'react'

/**
 * How far behind the provider the reveal is allowed to trail. Text that lands
 * in a slab (SDK and ACP bridges often forward 200–400 characters at once) is
 * spread over about this long instead of appearing all at once, and text that
 * trickles in token by token is shown within the same window.
 */
const TARGET_LAG_MS = 280
/** Once the turn has moved on, what is left drains this fast. */
const DRAIN_LAG_MS = 110
/** Never slower than this, so a short tail does not crawl. */
const MIN_CHARS_PER_MS = 0.09
/** The drain's floor: a rate that only tracks the backlog decays forever. */
const DRAIN_MIN_CHARS_PER_MS = 0.5
/** A backlog past this is not animated: the reveal skips to near its end. */
const MAX_BACKLOG = 2_400
const SKIP_TO_BACKLOG = 320
/** A cut that lands mid-word moves to the word's end when it is this close. */
const WORD_REACH = 14

/**
 * Reveal at once when the reader asked for less motion, and where there is no
 * display to pace for (no media queries: a DOM shim, not a window).
 */
function revealAtOnce(): boolean {
  if (typeof matchMedia !== 'function') return true
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The cut moved forward to the end of the word it falls in. */
function wordEnd(text: string, cut: number): number {
  if (cut >= text.length) return text.length
  const reach = Math.min(text.length, cut + WORD_REACH)
  for (let i = cut; i < reach; i++) {
    const c = text.charCodeAt(i)
    // space, newline, tab
    if (c === 32 || c === 10 || c === 9) return i
  }
  // The last word received so far is shown whole.
  return reach === text.length ? text.length : cut
}

/**
 * Paces a streamed reply's text so it flows rather than lands in chunks: the
 * visible prefix catches up with the received text at a rate proportional to
 * the backlog, cut on word ends. Text that was never streamed here (history,
 * a settled reply) is returned whole at once.
 *
 * The rate adapts, so the reveal never falls more than a fraction of a second
 * behind the provider however bursty it is, and it never invents a delay for
 * text that arrives slowly. When `streaming` turns off, the remainder drains
 * quickly instead of snapping in.
 */
export function useSmoothText(text: string, streaming: boolean, enabled = true): string {
  // A paced block that is streaming when it mounts reveals from nothing.
  const shownRef = useRef(enabled && streaming ? 0 : text.length)
  if (!enabled) shownRef.current = text.length
  const textRef = useRef(text)
  textRef.current = text
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const frameRef = useRef<number | null>(null)
  const lastRef = useRef(0)
  const [, setTick] = useState(0)

  // Text that shrank or was replaced (a `replace` snapshot) restarts the reveal
  // at whatever still matches, never past the new end.
  if (shownRef.current > text.length) shownRef.current = text.length

  const behind = enabled && shownRef.current < text.length

  useEffect(() => {
    if (!behind || frameRef.current !== null) return
    if (revealAtOnce()) {
      shownRef.current = textRef.current.length
      setTick((n) => n + 1)
      return
    }
    lastRef.current = performance.now()
    const step = (now: number): void => {
      const target = textRef.current
      const dt = Math.min(64, Math.max(0, now - lastRef.current))
      lastRef.current = now
      let shown = shownRef.current
      let backlog = target.length - shown
      if (backlog > MAX_BACKLOG) {
        shown = target.length - SKIP_TO_BACKLOG
        backlog = SKIP_TO_BACKLOG
      }
      const rate = streamingRef.current
        ? Math.max(MIN_CHARS_PER_MS, backlog / TARGET_LAG_MS)
        : Math.max(DRAIN_MIN_CHARS_PER_MS, backlog / DRAIN_LAG_MS)
      const next = wordEnd(target, Math.ceil(shown + rate * dt))
      if (next !== shownRef.current) {
        shownRef.current = Math.min(next, target.length)
        setTick((n) => n + 1)
      }
      if (shownRef.current < textRef.current.length) {
        frameRef.current = requestAnimationFrame(step)
      } else {
        frameRef.current = null
      }
    }
    frameRef.current = requestAnimationFrame(step)
  }, [behind, text])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  return shownRef.current >= text.length ? text : text.slice(0, shownRef.current)
}
