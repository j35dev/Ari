/**
 * Prompt Stash (T3 parity): a provider-agnostic clipboard of prompts that
 * survives across sessions. Stored in localStorage — drafts are cheap to
 * lose and never secret; the engine journal is the wrong home for them.
 */

export interface StashEntry {
  text: string
  savedAt: number
}

const STORAGE_KEY = 'ari.prompt-stash'
export const STASH_LIMIT = 20

export function loadStash(storage: Storage | null = safeLocalStorage()): StashEntry[] {
  if (storage === null) return []
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: StashEntry[] = []
    for (const item of parsed) {
      const value = item as { text?: unknown; savedAt?: unknown }
      if (typeof value.text !== 'string' || typeof value.savedAt !== 'number') continue
      entries.push({ text: value.text, savedAt: value.savedAt })
    }
    return entries
  } catch {
    // Corrupt stash must never block composing.
    return []
  }
}

export function persistStash(
  entries: StashEntry[],
  storage: Storage | null = safeLocalStorage(),
): void {
  if (storage === null) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota/privacy failures degrade silently; the stash is a convenience.
  }
}

/**
 * Adds a prompt to the stash: newest first, capped at {@link STASH_LIMIT},
 * consecutive duplicates collapse onto the existing entry (bumping its date).
 */
export function stashPrompt(text: string, existing: StashEntry[], now = Date.now()): StashEntry[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return existing
  const withoutDupes = existing.filter((e) => e.text !== trimmed)
  return [{ text: trimmed, savedAt: now }, ...withoutDupes].slice(0, STASH_LIMIT)
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
