import { useEffect, useRef, useState } from 'react'
import type { WidgetSnapshot } from '../../main/aria-widget/model'
import { defaultThemeId } from '@ari/ui/themes'
import { startRecording } from '../src/features/speech/recorder'
import { RecordingFlow } from './flow'
import { Widget } from './Widget'

declare global {
  interface Window {
    ariaWidget: {
      invoke: (method: string, params?: unknown) => Promise<unknown>
      onState: (callback: (state: WidgetSnapshot) => void) => () => void
    }
  }
}

export function WidgetApp(): React.JSX.Element {
  const [state, setState] = useState<WidgetSnapshot>({
    id: 0,
    phase: 'hidden',
    text: '',
    setup: false,
    theme: defaultThemeId,
    reducedMotion: false,
  })
  const [level, setLevel] = useState(0)
  const flowRef = useRef<RecordingFlow | null>(null)
  useEffect(() => {
    const flow = new RecordingFlow({ record: startRecording, invoke: window.ariaWidget.invoke })
    flowRef.current = flow
    let disposed = false
    const receive = (next: WidgetSnapshot): void => {
      if (disposed) return
      document.documentElement.dataset['ariTheme'] = next.theme
      document.documentElement.dataset['reducedMotion'] = String(next.reducedMotion)
      setState(next)
      flow.observe(next)
    }
    const unsubscribe = window.ariaWidget.onState(receive)
    void window.ariaWidget
      .invoke('ariaWidget.ready')
      .then((next) => receive(next as WidgetSnapshot))
    return () => {
      disposed = true
      unsubscribe()
      flow.dispose()
      flowRef.current = null
    }
  }, [])

  useEffect(() => {
    if (state.phase !== 'listening') return
    const timer = setInterval(() => setLevel(flowRef.current?.level() ?? 0), 50)
    return () => clearInterval(timer)
  }, [state.phase])

  return (
    <Widget
      state={state}
      level={level}
      onSetup={() => {
        void window.ariaWidget.invoke('ariaWidget.settings')
      }}
    />
  )
}
