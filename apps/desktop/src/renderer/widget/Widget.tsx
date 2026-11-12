import { useState } from 'react'
import { AriaMark } from '@ari/ui/aria-mark'
import type { WidgetSnapshot } from '../../main/aria-widget/model'
import {
  LevelMeter,
  REDUCED_MOTION_STRIDE,
  levelCells,
  pushCells,
} from '../src/features/composer/LevelMeter'

/** The pill is small: it shows a shorter run of the composer's meter. */
const WIDGET_BARS = 24

/** The meter's history for one recording, rebuilt from the level readings as they arrive. */
interface MeterTrace {
  /** The recording these bars belong to: a new one starts the row over. */
  run: string
  level: number
  cells: number[]
  /** Readings seen, and the loudest since the last bar, for the reduced-motion stride. */
  readings: number
  peak: number
}
import { DictationIndicator } from './DictationIndicator'

export function Widget(props: {
  state: WidgetSnapshot
  level: number
  onSetup: () => void
}): React.JSX.Element | null {
  const { state, level, onSetup } = props
  const run = `${state.id}:${state.phase}`
  const [trace, setTrace] = useState<MeterTrace>({ run, level, cells: [], readings: 0, peak: 0 })
  // State adjusted while rendering, not in an effect: the row is a pure
  // function of the readings so far, and React re-renders before painting.
  if (trace.run !== run) {
    setTrace({ run, level, cells: [], readings: 0, peak: 0 })
  } else if (trace.level !== level) {
    // Asked for less motion, the meter steps a few times a second instead of
    // streaming; each bar then holds the loudest reading it covered.
    const stride = state.reducedMotion ? REDUCED_MOTION_STRIDE : 1
    const readings = trace.readings + 1
    const peak = Math.max(trace.peak, level)
    setTrace(
      readings % stride === 0
        ? { run, level, cells: pushCells(trace.cells, levelCells(peak)), readings, peak: 0 }
        : { ...trace, level, readings, peak },
    )
  }
  if (state.destination === 'dictation') return <DictationIndicator {...props} />
  if (state.phase === 'hidden') return null
  const text =
    state.phase === 'listening'
      ? 'Listening'
      : state.phase === 'transcribing'
        ? 'Transcribing'
        : state.text
  const pose =
    state.phase === 'error' ? 'attention' : state.phase === 'transcribing' ? 'thinking' : 'idle'
  return (
    <button
      className="aria-pill"
      data-phase={state.phase}
      onClick={state.setup ? onSetup : undefined}
      tabIndex={-1}
      aria-label={state.setup ? `${text}. Open speech settings` : text}
    >
      <AriaMark size={24} state={pose} />
      <span className="aria-pill-text" role="status">
        {text}
      </span>
      {state.phase === 'listening' && (
        <LevelMeter cells={trace.cells} bars={WIDGET_BARS} label="Microphone level" />
      )}
      {state.phase === 'transcribing' && (
        <span className="aria-progress" aria-hidden="true">
          ···
        </span>
      )}
      {state.phase === 'sent' && (
        <span className="aria-sent" aria-label="Sent">
          ✓
        </span>
      )}
    </button>
  )
}
