import { useCallback, useEffect, useRef, useState } from 'react'

/** localStorage key holding the `sessionId -> draft text` map (M6.7). */
export const DRAFTS_STORAGE_KEY = 'ari.drafts'

/** Debounce window for persisting edits to localStorage. */
const WRITE_DEBOUNCE_MS = 300

type DraftMap = Record<string, string>

export type DraftUpdater = string | ((prev: string) => string)

export interface UseDraftsResult {
  /** Current draft text for the session. */
  draft: string
  /** Update the draft; persists to localStorage after the debounce window. */
  setDraft: (text: DraftUpdater) => void
}

function readDrafts(): DraftMap {
  try {
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (raw == null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const drafts: DraftMap = {}
    for (const [sessionId, text] of Object.entries(parsed)) {
      if (typeof text === 'string') drafts[sessionId] = text
    }
    return drafts
  } catch {
    return {}
  }
}

function loadDraft(sessionId: string): string {
  if (sessionId === '') return ''
  return readDrafts()[sessionId] ?? ''
}

function writeDraft(sessionId: string, text: string): void {
  // Tests (and any caller without a session) keep the field in memory only.
  if (sessionId === '') return
  const drafts = readDrafts()
  if (text === '') {
    delete drafts[sessionId]
  } else {
    drafts[sessionId] = text
  }
  window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
}

/**
 * Per-session composer draft (M6.7). Loads the stored draft synchronously,
 * keeps edits in state instantly, and writes the whole draft map back to
 * localStorage (`ari.drafts`) with a 300ms debounce; pending edits are
 * flushed when the session changes or the component unmounts so nothing is
 * lost. An empty draft clears the session's entry.
 */
export function useDrafts(sessionId: string): UseDraftsResult {
  const [draft, setDraft] = useState(() => loadDraft(sessionId))
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
    writeDraft(pending.sessionId, pending.text)
  }, [])

  const setDraftDebounced = useCallback(
    (next: DraftUpdater) => {
      const text = typeof next === 'function' ? next(draftRef.current) : next
      draftRef.current = text
      setDraft(text)
      pendingRef.current = { sessionId, text }
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, WRITE_DEBOUNCE_MS)
    },
    [sessionId, flush],
  )

  // Switching sessions: flush the old session's pending edit, then load the
  // new session's stored draft.
  useEffect(() => {
    const stored = loadDraft(sessionId)
    draftRef.current = stored
    setDraft(stored)
    return flush
  }, [sessionId, flush])

  useEffect(() => window.clearTimeout(timerRef.current), [])

  return { draft, setDraft: setDraftDebounced }
}
