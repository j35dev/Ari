import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:focus-timer')

export type FocusTimerStatus = 'idle' | 'running' | 'paused' | 'finished'

/** Persisted timer shape; absolute `endsAt` keeps countdowns exact across remounts and restarts. */
export interface FocusTimerSnapshot {
  status: FocusTimerStatus
  name: string
  durationMs: number
  /** Wall-clock expiry; meaningful only while running. */
  endsAt: number
  /** Frozen remainder; meaningful only while paused. */
  remainingMs: number
}

export const FOCUS_TIMER_STORAGE_KEY = 'ari.focus.timer.v1'
/** Header-pill width guard: names longer than this truncate with …. */
export const FOCUS_TIMER_NAME_LIMIT = 18
export const FOCUS_TIMER_MIN_MS = 60_000
export const FOCUS_TIMER_MAX_MS = 4 * 60 * 60_000
export const FOCUS_TIMER_PRESETS_MIN = [15, 25, 50]

function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 25 * 60_000
  return Math.min(FOCUS_TIMER_MAX_MS, Math.max(FOCUS_TIMER_MIN_MS, Math.round(durationMs)))
}

/** Short pill form: `38m`, `1h 05m`, `45s`. Never negative. */
export function formatTimerRemaining(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const totalSeconds = Math.ceil(clamped / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

/** Width guard for the header pill; CSS also truncates as defense in depth. */
export function truncateTimerName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length <= FOCUS_TIMER_NAME_LIMIT) return trimmed
  return `${trimmed.slice(0, FOCUS_TIMER_NAME_LIMIT - 1)}…`
}

/**
 * Pomodoro-style countdown independent of any music state. Time is derived
 * from an absolute `endsAt`, so closing the popover, rerendering, or
 * navigating never perturbs the countdown — only wall-clock time advances it.
 */
export class FocusTimer {
  #status: FocusTimerStatus = 'idle'
  #name = ''
  #durationMs = 0
  #endsAt = 0
  #remainingMs = 0

  get status(): FocusTimerStatus {
    return this.#status
  }

  get name(): string {
    return this.#name
  }

  get durationMs(): number {
    return this.#durationMs
  }

  remainingMs(now: number = Date.now()): number {
    if (this.#status === 'running') return Math.max(0, this.#endsAt - now)
    if (this.#status === 'paused') return this.#remainingMs
    return 0
  }

  start(name: string, durationMs: number, now: number = Date.now()): void {
    const trimmed = name.trim()
    this.#name = trimmed.length > 0 ? trimmed : 'Focus'
    this.#durationMs = clampDuration(durationMs)
    this.#endsAt = now + this.#durationMs
    this.#remainingMs = this.#durationMs
    this.#status = 'running'
  }

  pause(now: number = Date.now()): void {
    if (this.#status !== 'running') return
    this.#remainingMs = Math.max(0, this.#endsAt - now)
    this.#status = this.#remainingMs <= 0 ? 'finished' : 'paused'
  }

  resume(now: number = Date.now()): void {
    if (this.#status !== 'paused') return
    if (this.#remainingMs <= 0) {
      this.#status = 'finished'
      return
    }
    this.#endsAt = now + this.#remainingMs
    this.#status = 'running'
  }

  cancel(): void {
    this.#status = 'idle'
    this.#name = ''
    this.#durationMs = 0
    this.#endsAt = 0
    this.#remainingMs = 0
  }

  /** Advances a running timer; true on the tick that finishes it. */
  tick(now: number = Date.now()): boolean {
    if (this.#status !== 'running' || this.#endsAt > now) return false
    this.#remainingMs = 0
    this.#status = 'finished'
    return true
  }

  snapshot(): FocusTimerSnapshot {
    return {
      status: this.#status,
      name: this.#name,
      durationMs: this.#durationMs,
      endsAt: this.#endsAt,
      remainingMs: this.#remainingMs,
    }
  }

  /**
   * Restores persisted state without ever producing a stale countdown: an
   * expiry that passed while Ari was closed becomes `finished` (remaining 0),
   * never a negative or resurrected timer.
   */
  static restore(snapshot: FocusTimerSnapshot | null, now: number = Date.now()): FocusTimer {
    const timer = new FocusTimer()
    if (!snapshot || (snapshot.status !== 'running' && snapshot.status !== 'paused')) return timer
    timer.#name = typeof snapshot.name === 'string' ? snapshot.name : 'Focus'
    timer.#durationMs = clampDuration(snapshot.durationMs)
    if (snapshot.status === 'paused') {
      timer.#remainingMs = Math.min(
        timer.#durationMs,
        Math.max(0, Math.round(snapshot.remainingMs)),
      )
      timer.#status = timer.#remainingMs <= 0 ? 'finished' : 'paused'
      return timer
    }
    if (typeof snapshot.endsAt !== 'number' || snapshot.endsAt <= now) return timer
    timer.#endsAt = snapshot.endsAt
    timer.#remainingMs = Math.max(0, snapshot.endsAt - now)
    timer.#status = 'running'
    return timer
  }
}

function isSnapshot(value: unknown): value is FocusTimerSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    (row['status'] === 'running' || row['status'] === 'paused') &&
    typeof row['name'] === 'string' &&
    typeof row['durationMs'] === 'number' &&
    typeof row['endsAt'] === 'number' &&
    typeof row['remainingMs'] === 'number'
  )
}

/** Reads the persisted timer; corrupt or finished/idle payloads restore as idle. */
export function loadTimerSnapshot(): FocusTimerSnapshot | null {
  try {
    const raw = localStorage.getItem(FOCUS_TIMER_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSnapshot(parsed) ? parsed : null
  } catch (error) {
    log.warn('focus timer restore failed', error)
    return null
  }
}

export function saveTimerSnapshot(snapshot: FocusTimerSnapshot): void {
  try {
    if (snapshot.status === 'idle' || snapshot.status === 'finished') {
      localStorage.removeItem(FOCUS_TIMER_STORAGE_KEY)
      return
    }
    localStorage.setItem(FOCUS_TIMER_STORAGE_KEY, JSON.stringify(snapshot))
  } catch (error) {
    log.warn('focus timer persist failed', error)
  }
}

/**
 * Header-owned timer state: the pill stays mounted while the popover opens
 * and closes, and localStorage carries running/paused timers across
 * navigation and restarts. Ticks once per second only while running.
 */
export function useFocusTimer(): FocusTimerHandle {
  const ref = useRef<FocusTimer | null>(null)
  ref.current ??= FocusTimer.restore(loadTimerSnapshot())
  const timer = ref.current
  const [, setVersion] = useState(0)
  const poke = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    if (timer.status !== 'running') return
    const id = window.setInterval(() => {
      timer.tick(Date.now())
      saveTimerSnapshot(timer.snapshot())
      poke()
    }, 1000)
    return () => window.clearInterval(id)
  }, [timer, poke, timer.status])

  const start = useCallback(
    (name: string, durationMs: number) => {
      timer.start(name, durationMs)
      saveTimerSnapshot(timer.snapshot())
      poke()
    },
    [timer, poke],
  )
  const pause = useCallback(() => {
    timer.pause()
    saveTimerSnapshot(timer.snapshot())
    poke()
  }, [timer, poke])
  const resume = useCallback(() => {
    timer.resume()
    saveTimerSnapshot(timer.snapshot())
    poke()
  }, [timer, poke])
  const cancel = useCallback(() => {
    timer.cancel()
    saveTimerSnapshot(timer.snapshot())
    poke()
  }, [timer, poke])

  return {
    status: timer.status,
    name: timer.name,
    remainingMs: timer.remainingMs(),
    durationMs: timer.durationMs,
    start,
    pause,
    resume,
    cancel,
  }
}

/** Single owner per pill: the header pill creates this once and hands it to the popover. */
export interface FocusTimerHandle {
  status: FocusTimerStatus
  name: string
  remainingMs: number
  durationMs: number
  start: (name: string, durationMs: number) => void
  pause: () => void
  resume: () => void
  cancel: () => void
}
