import { useToast } from '@ari/ui/toast'
import type { SpeechProgress } from '@ari/contracts/rpc'
import { useEffect } from 'react'
import { VoicePlayback } from './voice-playback'
import { rpc } from '../../lib/rpc'

export function useVoicePlayback(): void {
  const { toast } = useToast()
  useEffect(() => {
    const bridge = window.ari?.voice
    if (!bridge) return
    const playback = new VoicePlayback((id, generation, error) => bridge.played(id, generation, error))
    const notice = rpc.subscribe('speech.progress', {}, payload => {
      const frame = payload as SpeechProgress
      if (frame.phase === 'error' && frame.error && ['aria-voice', 'groq'].includes(frame.id)) toast({ title: 'Aria speech', description: frame.error, tone: 'info' })
    })
    const off = bridge.onAudio(frame => void playback.observe(frame))
    const stop = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { playback.stop(); void rpc.invoke('aria.voice.stop') }
    }
    window.addEventListener('keydown', stop, true)
    return () => { notice(); off(); playback.dispose(); window.removeEventListener('keydown', stop, true) }
  }, [toast])
}
