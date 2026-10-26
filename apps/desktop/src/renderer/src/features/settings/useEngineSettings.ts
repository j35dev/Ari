import { useCallback, useEffect, useState } from 'react'
import type { Settings, SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('settings:engine')
const listeners = new Set<(settings: Settings) => void>()
let revision = 0

export interface EngineSettings {
  /** Current settings; null until the initial `settings.get` resolves. */
  settings: Settings | null
  /** True once the initial `settings.get` has settled, whether it loaded or failed. */
  loaded: boolean
  /** Persists a patch through the engine and syncs the local copy. */
  update: (patch: SettingsUpdate) => Promise<Settings>
}

/**
 * Renderer access to the engine-backed settings store. Loads once on mount
 * via `settings.get`; `update` persists a patch and adopts the engine's
 * returned settings as the new local state (single-writer semantics).
 */
export function useEngineSettings(): EngineSettings {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const initialRevision = revision
    const receive = (next: Settings): void => setSettings(next)
    listeners.add(receive)
    rpc.invoke('settings.get').then(
      (loaded) => {
        if (cancelled) return
        if (initialRevision === revision) setSettings(loaded)
        setLoaded(true)
      },
      (error: unknown) => {
        log.warn('settings.get failed; defaults apply', { error })
        if (!cancelled) setLoaded(true)
      },
    )
    return () => {
      cancelled = true
      listeners.delete(receive)
    }
  }, [])

  const update = useCallback(async (patch: SettingsUpdate): Promise<Settings> => {
    const next = await rpc.invoke('settings.update', patch)
    revision += 1
    for (const receive of listeners) receive(next)
    return next
  }, [])

  return { settings, loaded, update }
}
