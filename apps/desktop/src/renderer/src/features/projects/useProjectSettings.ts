import { useCallback, useEffect, useState } from 'react'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'

const STORAGE_PREFIX = 'ari.projectSettings.'

export interface ProjectSettingsData {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
}

/** Per-project defaults persisted to localStorage. Engine store takes over in M12. */
export function useProjectSettings(projectId: string) {
  const [settings, setSettings] = useState<ProjectSettingsData | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + projectId)
      if (raw) setSettings(JSON.parse(raw) as ProjectSettingsData)
    } catch {
      // corrupted — fall back to null
    }
  }, [projectId])

  const update = useCallback(
    (patch: Partial<ProjectSettingsData>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch } as ProjectSettingsData
        try {
          localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(next))
        } catch {
          // non-fatal
        }
        return next
      })
    },
    [projectId],
  )

  return { settings, update }
}
