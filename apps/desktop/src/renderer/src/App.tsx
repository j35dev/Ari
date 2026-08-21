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
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: '#0b0b0e',
        color: '#e6e6ea',
        fontFamily:
          "'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ fontSize: 44, letterSpacing: '0.22em', fontWeight: 600 }}>ARI</div>
      <div style={{ opacity: 0.55, fontSize: 13 }}>
        {bridge === 'connecting' && 'waking the engine…'}
        {bridge === 'alive' && `engine alive · ${new Date().toLocaleTimeString()}`}
        {bridge === 'broken' && 'bridge unreachable'}
      </div>
    </div>
  )
}
