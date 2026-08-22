import { useCallback, useEffect, useState } from 'react'
import type { Settings, SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('settings:engine')

export interface EngineSettings {
  /** Current settings; null until the initial `settings.get` resolves. */
  settings: Settings | null
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

  useEffect(() => {
    let cancelled = false
    rpc.invoke('settings.get').then(
      (loaded) => {
        if (!cancelled) setSettings(loaded)
      },
      (error: unknown) => {
        log.warn('settings.get failed; defaults apply', { error })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (patch: SettingsUpdate): Promise<Settings> => {
    const next = await rpc.invoke('settings.update', patch)
    setSettings(next)
    return next
  }, [])

  return { settings, update }
}
