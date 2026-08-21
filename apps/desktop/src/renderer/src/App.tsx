import { useEffect, useState } from 'react'

interface PingResult {
  pong: boolean
  at: number
}

declare global {
  interface Window {
    ari: {
      ping: () => Promise<PingResult>
    }
  }
}

export function App() {
  const [bridge, setBridge] = useState<'connecting' | 'alive' | 'broken'>('connecting')

  useEffect(() => {
    let cancelled = false
    window.ari
      .ping()
      .then((r) => {
        if (!cancelled) setBridge(r.pong ? 'alive' : 'broken')
      })
      .catch(() => {
        if (!cancelled) setBridge('broken')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-fg">
      <div className="text-[2rem] font-semibold tracking-[0.22em]">ARI</div>
      <div className="text-fg-muted text-[13px]">
        {bridge === 'connecting' && 'waking the engine…'}
        {bridge === 'alive' && `engine alive · ${new Date().toLocaleTimeString()}`}
        {bridge === 'broken' && 'bridge unreachable'}
      </div>
    </div>
  )
}
