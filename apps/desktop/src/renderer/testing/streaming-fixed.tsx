import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Titlebar } from '../src/shell/Titlebar'
import { TranscriptView } from '../src/features/transcript/TranscriptView'
import { Composer } from '../src/features/composer/Composer'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { currentMessages, qoderFixtures } from './streaming/qoder-stream'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import './streaming/streaming.css'

window.ari = {
  async invoke(method) {
    await Promise.resolve()
    if (method === 'stream.subscribe' || method === 'stream.unsubscribe')
      return { subscribed: true }
    if (method === 'speech.status') return { ready: false }
    throw new Error(`Fixture refuses ${method}`)
  },
  subscribe() {
    return () => {}
  },
}
document.documentElement.dataset.ariTheme = 'porcelain'
const parameters = new URLSearchParams(location.search)
function Regression() {
  const [id, setId] = useState(parameters.get('case') ?? 'interleaved')
  const fixture = qoderFixtures.find((item) => item.id === id)!
  const [cursor, setCursor] = useState(Number(parameters.get('at') ?? fixture.frames.length))
  const [playing, setPlaying] = useState(false)
  const frames = fixture.frames.slice(0, cursor)
  const messages = currentMessages(frames)
  const running = !frames.some((frame) => frame.end)
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(
      () =>
        setCursor((value) => {
          if (value >= fixture.frames.length) {
            setPlaying(false)
            return value
          }
          return value + 1
        }),
      200,
    )
    return () => clearInterval(timer)
  }, [playing, fixture])
  useEffect(() => {
    Object.assign(window, {
      __ari: {
        state: () => ({
          renderer: 'production TranscriptView',
          case: id,
          cursor,
          total: fixture.frames.length,
          playing,
          running,
          publicRows: document.querySelectorAll('.ari-md').length,
          activityGroups: document.querySelectorAll('.ari-burst').length,
          viewport: { width: innerWidth, height: innerHeight },
        }),
      },
    })
  }, [id, cursor, fixture, playing, running])
  return (
    <div className="review-shell ari-frame">
      <Titlebar
        leading={<div className="review-brand">Ari</div>}
        leadingWidth={264}
        projectLabel="Streaming regression"
        usage={
          <span className="review-view-caption">
            Actual session components · synthetic neutral input
          </span>
        }
      />
      <div className="review-workspace">
        <aside className="review-sidebar">
          <div className="review-aria ari-pixel">Aria</div>
          <label htmlFor="fixture">Regression case</label>
          <select
            id="fixture"
            value={id}
            onChange={(event) => {
              const next = qoderFixtures.find((item) => item.id === event.target.value)!
              setId(next.id)
              setCursor(next.frames.length)
              setPlaying(false)
            }}
          >
            {qoderFixtures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="review-playback">
            <button
              data-action="play"
              onClick={() => {
                if (playing) setPlaying(false)
                else {
                  setCursor(0)
                  setPlaying(true)
                }
              }}
            >
              {playing ? 'Pause' : 'Replay'}
            </button>
            <button
              data-action="finish"
              onClick={() => {
                setCursor(fixture.frames.length)
                setPlaying(false)
              }}
            >
              End
            </button>
            <span>
              {cursor}/{fixture.frames.length}
            </span>
          </div>
          <input
            aria-label="Replay position"
            type="range"
            min="0"
            max={fixture.frames.length}
            value={cursor}
            onChange={(event) => {
              setCursor(Number(event.target.value))
              setPlaying(false)
            }}
          />
          <p className="review-inspector">{fixture.description}</p>
          <p className="review-isolation">
            No provider or tool executes. The model-private lane contains synthetic placeholders
            only.
          </p>
        </aside>
        <main className="review-stage ari-stage">
          <div className="pane-origin ms-4 mt-2 text-xs text-fg-subtle">Started by Aria</div>
          <div className="review-source">
            <TranscriptView messages={messages} sessionId="regression" running={running} />
          </div>
          <div className="review-composer ari-chat-column">
            <Composer
              sessionId="regression-fixture"
              running={running}
              onSend={() => {}}
              onStop={() => setPlaying(false)}
            />
          </div>
        </main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <MotionProvider reducedMotion>
    <ToastProvider>
      <Regression />
    </ToastProvider>
  </MotionProvider>,
)
