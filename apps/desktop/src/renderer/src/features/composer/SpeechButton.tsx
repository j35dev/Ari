import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { startRecording } from '../speech/recorder'
import { useSpeech } from '../speech/useSpeech'
import type { DictationTarget } from '../../../../shared/dictation'

export function SpeechButton({
  disabled = false,
  captureTarget,
}: {
  disabled?: boolean
  captureTarget: () => DictationTarget
}) {
  const { status } = useSpeech()
  const recording = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const [level, setLevel] = useState(0)
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
  useEffect(() => {
    if (state !== 'recording') return
    const tick = setInterval(() => setLevel(recording.current?.level() ?? 0), 60)
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
  const title = unavailable
    ? 'Set up speech to text in Settings'
    : state === 'recording'
      ? 'Stop dictation (Enter); cancel (Esc)'
      : state === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate a message'
  return (
    <span title={title} className="relative flex shrink-0 items-center">
      <button
        type="button"
        aria-label={state === 'recording' ? 'Stop dictation' : 'Dictate a message'}
        aria-pressed={state === 'recording'}
        disabled={unavailable || state === 'starting' || state === 'transcribing'}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void (state === 'recording' ? stop() : start())}
        className={`relative flex h-7 w-7 items-center justify-center overflow-hidden rounded-md transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40 ${state === 'recording' ? 'text-accent' : 'text-fg-subtle hover:text-fg'}`}
      >
        {state === 'recording' && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 bg-accent/20"
            style={{ height: `${Math.max(10, level * 100)}%` }}
          />
        )}
        {state === 'starting' || state === 'transcribing' ? (
          <LoaderCircle size={14} className="animate-spin" aria-hidden />
        ) : state === 'recording' ? (
          <Square size={12} aria-hidden />
        ) : (
          <Mic size={14} aria-hidden />
        )}
      </button>
      {error && (
        <span role="alert" className="max-w-40 px-1 text-2xs text-danger">
          {error}
        </span>
      )}
    </span>
  )
}
