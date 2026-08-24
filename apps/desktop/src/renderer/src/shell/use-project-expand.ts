import { useCallback, useEffect, useState } from 'react'

/** localStorage key holding the `projectId -> expanded` map for sidebar groups. */
export const PROJECT_EXPAND_STORAGE_KEY = 'ari.sidebar.project-expanded'

function readMap(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PROJECT_EXPAND_STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

/**
 * Per-project sidebar expand state, persisted so a collapsed project stays
 * collapsed across restarts. Unknown projects default to expanded — a freshly
 * opened project should show its sessions immediately.
 */
export function useProjectExpand(): {
  isExpanded: (projectId: string) => boolean
  toggle: (projectId: string) => void
} {
  const [map, setMap] = useState<Record<string, boolean>>(readMap)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(PROJECT_EXPAND_STORAGE_KEY, JSON.stringify(map))
    } catch {
      // Quota or private-mode failures must never break sidebar rendering.
    }
  }, [map])

  const isExpanded = useCallback((projectId: string) => map[projectId] ?? true, [map])
  const toggle = useCallback((projectId: string) => {
    setMap((prev) => ({ ...prev, [projectId]: !(prev[projectId] ?? true) }))
  }, [])

  return { isExpanded, toggle }
}
