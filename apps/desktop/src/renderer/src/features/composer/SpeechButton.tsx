import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { startRecording } from '../speech/recorder'
import { useSpeech } from '../speech/useSpeech'

export function SpeechButton({
  disabled = false,
  onTranscript,
}: {
  disabled?: boolean
  onTranscript: (text: string) => void
}) {
  const { status } = useSpeech()
  const recording = useRef<Awaited<ReturnType<typeof startRecording>> | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const insert = useRef(onTranscript)
  insert.current = onTranscript

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      recording.current?.cancel()
      recording.current = null
    }
  }, [])
  useEffect(() => {
    if (!disabled && status.ready) return
    generation.current++
    recording.current?.cancel()
    recording.current = null
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
      if (!pcm.length) return
      const result = await rpc.invoke('speech.transcribe', { pcm })
      if (mounted.current && generation.current === attempt && result.text)
        insert.current(result.text)
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setState('idle')
    }
  }

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!recording.current) return
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
        setState('idle')
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  const start = async (): Promise<void> => {
    setError(null)
    setState('starting')
    const attempt = ++generation.current
    try {
      const active = await startRecording()
      if (!mounted.current || generation.current !== attempt) {
        active.cancel()
        return
      }
      recording.current = active
      setState('recording')
    } catch (reason) {
      if (mounted.current) {
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
