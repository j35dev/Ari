import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, LoaderCircle, Mic } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { iconButton } from '../../lib/recipes'
import { startRecording } from '../speech/recorder'
import { useSpeech } from '../speech/useSpeech'
import type { DictationTarget } from '../../../../shared/dictation'
import {
  LEVEL_BARS,
  LevelMeter,
  REDUCED_MOTION_STRIDE,
  levelCells,
  prefersReducedMotion,
  pushCells,
} from './LevelMeter'
import { roundButton } from './round-button'

/** Where a dictation is: nothing, acquiring the mic, capturing, or turning audio into text. */
export type SpeechState = 'idle' | 'starting' | 'recording' | 'transcribing'

/** What the status strip shows while recording: the level history and the clock. */
interface Meter {
  cells: number[]
  seconds: number
}

const EMPTY_METER: Meter = { cells: [], seconds: 0 }

/** `0:07`, `12:40`: elapsed recording time. */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function SpeechButton({
  disabled = false,
  captureTarget,
  statusSlot,
  onStateChange,
}: {
  disabled?: boolean
  captureTarget: () => DictationTarget
  /**
   * Where "Listening", the level meter and the timer are drawn. The composer
   * hands over the left side of its control row; without a slot they sit
   * beside the button.
   */
  statusSlot?: HTMLElement | null
  /** Tells the host which state the dictation is in, so it can make room. */
  onStateChange?: (state: SpeechState) => void
}) {
  const { status } = useSpeech()
  const recording = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const [state, setState] = useState<SpeechState>('idle')
  const [meter, setMeter] = useState<Meter>(EMPTY_METER)
  const [error, setError] = useState<string | null>(null)
  const target = useRef<DictationTarget | null>(null)
  const lease = useRef<string | null>(null)
  const busy = useRef(false)
  const release = (): void => {
    target.current?.cancel()
    target.current = null
    const token = lease.current
    lease.current = null
    if (token) void window.ari?.dictation?.release(token).catch(() => undefined)
    busy.current = false
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      recording.current?.cancel()
      recording.current = null
      release()
    }
  }, [])
  useEffect(() => {
    if (!disabled && status.ready) return
    generation.current++
    recording.current?.cancel()
    recording.current = null
    release()
    setState('idle')
  }, [disabled, status.ready])
  // Before paint, so the host never shows its pickers beside the status strip.
  useLayoutEffect(() => {
    onStateChange?.(state)
  }, [state, onStateChange])
  useEffect(() => {
    if (state !== 'recording') return
    const startedAt = Date.now()
    // Asked for less motion, the meter steps a few times a second instead of
    // streaming; each bar then holds the loudest level it covered.
    const stride = prefersReducedMotion() ? REDUCED_MOTION_STRIDE : 1
    let ticks = 0
    let peak = 0
    const tick = setInterval(() => {
      peak = Math.max(peak, recording.current?.level() ?? 0)
      ticks += 1
      const seconds = Math.floor((Date.now() - startedAt) / 1000)
      if (ticks % stride !== 0) {
        setMeter((prev) => (prev.seconds === seconds ? prev : { ...prev, seconds }))
        return
      }
      const cells = levelCells(peak)
      peak = 0
      setMeter((prev) => {
        // A steady level on a full meter draws the same row: skip the render.
        const steady = prev.cells.length === LEVEL_BARS && prev.cells.every((bar) => bar === cells)
        if (steady && prev.seconds === seconds) return prev
        return { cells: steady ? prev.cells : pushCells(prev.cells, cells), seconds }
      })
    }, 60)
    return () => clearInterval(tick)
  }, [state])

  const stop = async (): Promise<void> => {
    const active = recording.current
    if (!active) return
    recording.current = null
    const attempt = generation.current
    setState('transcribing')
    try {
      const pcm = await active.stop()
      if (!mounted.current || generation.current !== attempt || !pcm.length) return
      const result = await rpc.invoke('speech.transcribe', { pcm })
      if (mounted.current && generation.current === attempt && result.text.trim())
        await target.current?.insert(
          result.text,
          () => mounted.current && generation.current === attempt,
        )
    } catch (reason) {
      if (mounted.current && generation.current === attempt)
        setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation.current === attempt) {
        release()
        if (mounted.current) setState('idle')
      }
    }
  }

  useEffect(() => {
    const blur = (): void => {
      if (!busy.current) return
      generation.current++
      recording.current?.cancel()
      recording.current = null
      release()
      setState('idle')
    }
    const key = (event: KeyboardEvent): void => {
      if (!busy.current) return
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void stop()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        generation.current++
        recording.current?.cancel()
        recording.current = null
        release()
        setState('idle')
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const start = async (): Promise<void> => {
    if (busy.current || disabled || !status.ready) return
    busy.current = true
    setError(null)
    setState('starting')
    const attempt = ++generation.current
    try {
      // Capture synchronously, before microphone acquisition or any focus change.
      target.current = captureTarget()
      const token = await window.ari?.dictation?.acquire()
      if (!mounted.current || generation.current !== attempt) {
        if (token) void window.ari?.dictation?.release(token).catch(() => undefined)
        return
      }
      lease.current = token ?? null
      const active = await startRecording({
        onError: (reason) => {
          if (!mounted.current || generation.current !== attempt) return
          generation.current++
          recording.current?.cancel()
          recording.current = null
          release()
          setError(reason.message)
          setState('idle')
        },
      })
      if (!mounted.current || generation.current !== attempt) {
        active.cancel()
        return
      }
      recording.current = active
      setMeter(EMPTY_METER)
      setState('recording')
    } catch (reason) {
      if (mounted.current && generation.current === attempt) {
        release()
        setError(reason instanceof Error ? reason.message : String(reason))
        setState('idle')
      }
    }
  }
  const unavailable = disabled || !status.ready
  const listening = state === 'recording'
  // From the first captured sample until the transcript lands, the control is
  // the round button and the host's control row belongs to the dictation.
  const dictating = listening || state === 'transcribing'
  const title = unavailable
    ? 'Set up speech to text in Settings'
    : listening
      ? 'Stop dictation (Enter); cancel (Esc)'
      : state === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate a message'

  const statusStrip = dictating ? (
    <span data-dictation-status={state} className="flex min-w-0 flex-1 items-center">
      <span className="shrink-0 ps-[9px] text-[13.5px] text-fg">
        {listening ? 'Listening' : 'Transcribing'}
      </span>
      {listening ? (
        <>
          <span className="flex shrink-0 items-center px-2">
            <LevelMeter cells={meter.cells} />
          </span>
          <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-fg-subtle">
            {clock(meter.seconds)}
          </span>
        </>
      ) : null}
    </span>
  ) : null

  return (
    <span title={title} className="relative flex shrink-0 items-center">
      {statusSlot === undefined
        ? statusStrip
        : statusSlot !== null && statusStrip !== null
          ? createPortal(statusStrip, statusSlot)
          : null}
      {listening ? (
        <span className="shrink-0 whitespace-nowrap px-2 text-[12.5px] text-fg-subtle">
          Esc to discard
        </span>
      ) : null}
      {error && (
        <span role="alert" className="max-w-40 px-1.5 text-xs text-danger">
          {error}
        </span>
      )}
      <button
        type="button"
        aria-label={listening ? 'Stop dictation' : 'Dictate a message'}
        aria-pressed={listening}
        disabled={unavailable || state === 'starting' || state === 'transcribing'}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void (listening ? stop() : start())}
        className={dictating ? roundButton(listening ? 'ink' : 'idle') : iconButton}
      >
        {state === 'starting' || state === 'transcribing' ? (
          <LoaderCircle size={16} className="animate-spin" aria-hidden />
        ) : listening ? (
          <Check size={17} strokeWidth={2} aria-hidden />
        ) : (
          <Mic size={16} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </span>
  )
}
