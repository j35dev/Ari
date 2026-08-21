import { useEffect, useState } from 'react'
import { THEMES, ThemeProvider, useTheme } from '@ari/ui/theme-provider'
import { rpc } from './lib/rpc'

function BootSplash() {
  const [bridge, setBridge] = useState<'connecting' | 'alive' | 'broken'>('connecting')
  const [sessions, setSessions] = useState<string>('')
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    let cancelled = false
    rpc
      .invoke('ping')
      .then((r) => {
        if (!cancelled) setBridge(r.pong ? 'alive' : 'broken')
      })
      .catch(() => {
        if (!cancelled) setBridge('broken')
      })
    rpc
      .invoke('session.list')
      .then((list) => {
        if (!cancelled) setSessions(`${list.length} session(s) on disk`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-fg">
      <div className="text-[2rem] font-semibold tracking-[0.22em]">ARI</div>
      <div className="text-fg-muted text-[13px]">
        {bridge === 'connecting' && 'waking the engine…'}
        {bridge === 'alive' && `engine alive · ${sessions}`}
        {bridge === 'broken' && 'bridge unreachable'}
      </div>
      <div className="mt-6 flex gap-2" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTheme(t.id)}
            aria-pressed={theme === t.id}
            title={t.label}
            className={`h-6 w-6 rounded-full border transition-transform hover:scale-110 ${
              theme === t.id ? 'border-accent ring-2 ring-accent-ring' : 'border-border-strong'
            }`}
            style={{ background: 'var(--ari-accent)' }}
          />
        ))}
      </div>
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <BootSplash />
    </ThemeProvider>
  )
}
