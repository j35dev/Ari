import { useSyncExternalStore } from 'react'
import {
  assignSession,
  closePane,
  focusPane,
  initialLayout,
  paneIdForSession,
  parseLayout,
  pruneSessions,
  serializeLayout,
  splitPane,
  type PaneEdge,
  type SplitLayout,
} from './split-layout'

/** Where the pane layout is remembered between launches. */
export const SPLIT_LAYOUT_STORAGE_KEY = 'ari.split.layout'

function load(): SplitLayout {
  try {
    return parseLayout(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY)) ?? initialLayout()
  } catch {
    // Storage can refuse to be read at all (private mode, disabled cookies).
    return initialLayout()
  }
}

/**
 * The layout lives here rather than in `Shell` for the same reason the terminal
 * dock does: it outlives the component tree, so a renderer reload comes back to
 * the panes the user left. Reads answer from this variable, never from storage,
 * so a refused write costs the next launch's restore and nothing else.
 */
let layout: SplitLayout = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): SplitLayout => layout

let pendingWrite: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced because a separator drag rewrites the layout every frame, and a
 * synchronous `setItem` per frame is needless work for a value only the next
 * launch reads.
 */
function persist(next: SplitLayout): void {
  if (pendingWrite !== null) clearTimeout(pendingWrite)
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    try {
      localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeLayout(next))
    } catch {
      // Best effort: the in-memory layout is already the truth for this run.
    }
  }, 200)
}

function commit(next: SplitLayout): void {
  if (next === layout) return
  layout = next
  persist(next)
  for (const listener of listeners) listener()
}

/** The pane layout the shell renders. */
export function useSplitLayout(): SplitLayout {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The same layout, for the callers that are not components. */
export function splitLayoutSnapshot(): SplitLayout {
  return layout
}

/**
 * The layout rewrites, as the shell calls them. Module-level and therefore
 * identity-stable, so they can sit in dependency arrays without churn.
 */
export const splitLayoutActions = {
  /** Focus follows the pointer, so a pane is active before its content reacts. */
  focus: (paneId: string): void => commit(focusPane(layout, paneId)),

  /** Splits a pane, leaving the new one blank for a session to be dropped in. */
  split: (paneId: string, edge: PaneEdge): void => commit(splitPane(layout, paneId, edge)),

  /** Puts a session in a pane — what every session-list click resolves to. */
  assign: (paneId: string, sessionId: string): void =>
    commit(assignSession(layout, paneId, sessionId)),

  close: (paneId: string): void => commit(closePane(layout, paneId)),

  /** Blanks panes whose session is gone, keeping the shape they were in. */
  prune: (liveIds: ReadonlySet<string>): void => commit(pruneSessions(layout, liveIds)),

  /** The pane already showing a session, so a click focuses instead of re-opening. */
  paneOf: (sessionId: string): string | null => paneIdForSession(layout, sessionId),

  /** Test seam: forgets the layout so each case starts from a single blank pane. */
  reset: (): void => {
    if (pendingWrite !== null) {
      clearTimeout(pendingWrite)
      pendingWrite = null
    }
    commit(initialLayout())
  },
}
