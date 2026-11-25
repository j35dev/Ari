import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TranscriptView } from '../src/features/transcript/TranscriptView'
import { WorkingGlyph } from '../src/features/moment/WorkingGlyph'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { messagesAt, timeline, type Delivery } from './stream-replay/script'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'

/**
 * Offline replay of one realistic agent turn through the production
 * transcript, at real speed. `?delivery=tokens|bursts&theme=obsidian|porcelain`.
 * `window.__replay.start()` restarts it; `window.__replay.state()` reports.
 */

window.ari = {
  async invoke(method: string) {
    await Promise.resolve()
    if (method === 'stream.subscribe' || method === 'stream.unsubscribe')
      return { subscribed: true }
    if (method === 'speech.status') return { ready: false }
    throw new Error(`Replay refuses ${method}`)
  },
  subscribe() {
    return () => {}
  },
}

const params = new URLSearchParams(location.search)
document.documentElement.dataset.ariTheme = params.get('theme') ?? 'obsidian'
const delivery = (params.get('delivery') as Delivery | null) ?? 'tokens'

function Replay() {
  const flushes = useMemo(() => timeline(delivery), [])
  const [cursor, setCursor] = useState(
    Number(params.get('at') ?? (params.has('play') ? 0 : flushes.length)),
  )
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const start = (): void => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setCursor(0)
    const t0 = Date.now()
    setStartedAt(t0)
    flushes.forEach((flush, i) => {
      timers.current.push(setTimeout(() => setCursor(i + 1), flush.at))
    })
  }

  useEffect(() => {
    if (params.has('play')) start()
    return () => timers.current.forEach(clearTimeout)
  }, [])

  const latest = useMemo(() => messagesAt(flushes, cursor), [flushes, cursor])
  const messages = useDeferredValue(latest)
  const running = cursor < flushes.length

  useEffect(() => {
    Object.assign(window, {
      __replay: {
        start,
        state: () => ({ cursor, total: flushes.length, running, delivery }),
      },
    })
  })

  return (
    <div className="ari-frame" style={{ height: '100dvh', padding: 8, display: 'flex' }}>
      <main className="ari-stage" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TranscriptView
            sessionId="replay"
            messages={messages}
            running={running}
            working={running ? <WorkingGlyph startedAt={startedAt} /> : null}
          />
        </div>
        <div
          className="ari-chat-column"
          style={{
            height: 96,
            margin: '0 auto 16px',
            borderRadius: 16,
            border: '1px solid var(--ari-border)',
            background: 'var(--ari-surface-1)',
          }}
        />
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <ToastProvider>
      <Replay />
    </ToastProvider>
  </MotionProvider>,
)
