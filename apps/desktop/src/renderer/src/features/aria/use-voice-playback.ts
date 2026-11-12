import { useEffect } from 'react'
import { VoicePlayback } from './voice-playback'
import { rpc } from '../../lib/rpc'

export function useVoicePlayback(): void {
  useEffect(() => {
    const bridge = window.ari?.voice
    if (!bridge) return
    const playback = new VoicePlayback((id, generation, error) => bridge.played(id, generation, error))
    const off = bridge.onAudio(frame => void playback.observe(frame))
    const stop = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { playback.stop(); void rpc.invoke('aria.voice.stop') }
    }
    window.addEventListener('keydown', stop, true)
    return () => { off(); playback.dispose(); window.removeEventListener('keydown', stop, true) }
  }, [])
}
