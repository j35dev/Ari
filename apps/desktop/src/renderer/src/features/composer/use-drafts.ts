import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** localStorage key holding the `sessionId -> draft text` map (M6.7). */
export const DRAFTS_STORAGE_KEY = 'ari.drafts'

/** Debounce window for persisting edits to localStorage. */
const WRITE_DEBOUNCE_MS = 300

type DraftMap = Record<string, string>
const cache = new Map<string, { text: string; storageIssue?: boolean }>()
const deleted = new Set<string>()
const listeners = new Set<() => void>()
const EMPTY = { text: '' }
function emit(): void {
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export type DraftUpdater = string | ((prev: string) => string)

export interface UseDraftsResult {
  /** Current draft text for the session. */
  draft: string
  /** Update the draft; persists to localStorage after the debounce window. */
  setDraft: (text: DraftUpdater) => void
  storageIssue?: boolean
}

function readDrafts(strict = false): DraftMap {
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (raw == null) return {}
    if (raw.length > 2 * 1024 * 1024) throw new Error('Draft storage is too large to read')
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Draft storage is unreadable')
    const drafts: DraftMap = Object.create(null) as DraftMap
    for (const [sessionId, text] of Object.entries(parsed)) {
      if (sessionId.length <= 128 && typeof text === 'string') drafts[sessionId] = text
      else if (strict) throw new Error('Draft storage contains unreadable entries')
    }
    return drafts
  } catch (error) {
    if (strict) throw error
    return {}
  }
}

function loadDraft(sessionId: string): typeof EMPTY & { storageIssue?: boolean } {
  if (sessionId === '') return EMPTY
  if (!cache.has(sessionId))
    cache.set(sessionId, { text: deleted.has(sessionId) ? '' : (readDrafts()[sessionId] ?? '') })
  return cache.get(sessionId)!
}
export function readSessionDraftText(sessionId: string): string {
  return loadDraft(sessionId).text
}

function writeDraft(sessionId: string, text: string): void {
  // Tests (and any caller without a session) keep the field in memory only.
  if (sessionId === '') return
  if (deleted.has(sessionId)) return
  try {
    // Never replace an unreadable collection with a partial in-memory map.
    const drafts = readDrafts(true)
    if (text === '') delete drafts[sessionId]
    else drafts[sessionId] = text
    const raw = JSON.stringify(drafts)
    if (Object.keys(drafts).length > 100 || raw.length > 2 * 1024 * 1024)
      throw new Error('Draft storage is full')
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, raw)
    cache.set(sessionId, { text })
  } catch {
    cache.set(sessionId, { text, storageIssue: true })
  }
  emit()
}

export function deleteSessionDraftText(sessionId: string): void {
  deleted.add(sessionId)
  cache.set(sessionId, EMPTY)
  try {
    const drafts = readDrafts(true)
    delete drafts[sessionId]
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    /* Keep the deletion in memory. */
  }
  emit()
}
export function dropDraftTextMemory(): void {
  cache.clear()
  deleted.clear()
}

/**
 * Per-session composer draft (M6.7). Loads the stored draft synchronously,
 * keeps edits in state instantly, and writes the whole draft map back to
 * localStorage (`ari.drafts`) with a 300ms debounce; pending edits are
 * flushed when the session changes, the component unmounts, or the page exits.
 * Mounted copies share the latest text; storage failure retains it in memory.
 * An empty draft clears the session's entry.
 */
export function useDrafts(sessionId: string): UseDraftsResult {
  const entry = useSyncExternalStore(subscribe, () => loadDraft(sessionId))
  const [local, setLocal] = useState('')
  const draft = sessionId ? entry.text : local
  const draftRef = useRef(draft)
  draftRef.current = draft
  const pendingRef = useRef<{ sessionId: string; text: string } | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  const flush = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
    if (!pending.sessionId || loadDraft(pending.sessionId).text === pending.text)
      writeDraft(pending.sessionId, pending.text)
  }, [])

  const setDraftDebounced = useCallback(
    (next: DraftUpdater) => {
      if (deleted.has(sessionId)) return
      const previous = sessionId ? loadDraft(sessionId).text : draftRef.current
      const text = typeof next === 'function' ? next(previous) : next
      draftRef.current = text
      if (sessionId) {
        cache.set(sessionId, { text, storageIssue: loadDraft(sessionId).storageIssue })
        emit()
      } else setLocal(text)
      pendingRef.current = { sessionId, text }
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, WRITE_DEBOUNCE_MS)
    },
    [sessionId, flush],
  )

  // Switching sessions: flush the old session's pending edit, then load the
  // new session's stored draft.
  useEffect(() => {
    return flush
  }, [sessionId, flush])

  useEffect(() => window.clearTimeout(timerRef.current), [])

  // Compatible with #473: reload does not unmount React before discarding it.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [flush])

  return { draft, setDraft: setDraftDebounced, storageIssue: entry.storageIssue }
}
