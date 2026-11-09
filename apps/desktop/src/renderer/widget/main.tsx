import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import '@ari/ui/tokens.css'
import type { WidgetSnapshot } from '../../main/aria-widget/model'
import { startRecording } from '../src/features/speech/recorder'
import { RecordingFlow } from './flow'
import { Widget } from './Widget'
import './widget.css'

declare global {
  interface Window {
    ariaWidget: {
      invoke: (method: string, params?: unknown) => Promise<unknown>
      onState: (callback: (state: WidgetSnapshot) => void) => () => void
    }
  }
}

function App(): React.JSX.Element {
  const [state, setState] = useState<WidgetSnapshot>({
    id: 0,
    phase: 'hidden',
    text: '',
    setup: false,
    theme: 'obsidian',
    reducedMotion: false,
  })
  const [level, setLevel] = useState(0)
  useEffect(() => {
    const flow = new RecordingFlow({ record: startRecording, invoke: window.ariaWidget.invoke })
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
    const timer = setInterval(() => setLevel(flow.level()), 50)
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
      flow.dispose()
    }
  }, [])
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

createRoot(document.getElementById('root')!).render(<App />)
