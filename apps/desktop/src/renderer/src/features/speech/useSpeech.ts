import { useCallback, useEffect, useState } from 'react'
import type { SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

export function useSpeech() {
  const [status, setStatus] = useState<SpeechStatus>({
    engine: 'missing',
    model: null,
    ready: false,
  })
  const [progress, setProgress] = useState<Record<string, SpeechProgress>>({})
  const refresh = useCallback(async () => {
    const next = await rpc.invoke('speech.status')
    if (next) setStatus(next)
  }, [])
  useEffect(() => {
    let active = true
    const read = async () => {
      const next = await rpc.invoke('speech.status')
      if (active && next) setStatus(next)
    }
    void read().catch(() => undefined)
    const off = rpc.subscribe('speech.progress', {}, (payload) => {
      if (!active) return
      const frame = payload as SpeechProgress
      setProgress((current) => ({ ...current, [frame.id]: frame }))
      void read().catch(() => undefined)
    })
    return () => {
      active = false
      off()
    }
  }, [])
  return { status, progress, refresh }
}
