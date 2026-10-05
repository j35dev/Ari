import { useSyncExternalStore } from 'react'
import {
  closeSpace,
  createSpace,
  cycleSpace,
  initialSpaceStore,
  MAX_SPACES,
  moveSpace,
  parseLegacyLayout,
  parseSpaceStore,
  pruneSpaceSessions,
  renameSpace,
  selectSpace,
  selectSpaceAt,
  serializeSpaceStore,
  type SpaceStore,
} from './spaces'

/** Where the space list is remembered between launches. */
export const SPACES_STORAGE_KEY = 'ari.spaces'

/** The single-layout key a pre-spaces build left behind, migrated on first read. */
export const LEGACY_SPLIT_LAYOUT_STORAGE_KEY = 'ari.split.layout'

/**
 * The one space on screen today. Missing or unreadable storage falls back to a
 * clean store; a store from before spaces existed is wrapped as the first tab,
 * so an upgrade keeps the panes the user left open instead of resetting them.
 */
function load(): SpaceStore {
  try {
    const raw = localStorage.getItem(SPACES_STORAGE_KEY)
    if (raw !== null) return parseSpaceStore(raw) ?? initialSpaceStore()
    return (
      parseLegacyLayout(localStorage.getItem(LEGACY_SPLIT_LAYOUT_STORAGE_KEY)) ??
      initialSpaceStore()
    )
  } catch {
    // Storage can refuse to be read at all (private mode, disabled cookies).
    return initialSpaceStore()
  }
}

/**
 * The store lives here rather than in `Shell` so it outlives the component
 * tree: a renderer reload comes back to the same tabs, and the split facade
 * can read it without a React context. Reads answer from this variable, never
 * from storage, so a refused write costs the next launch's restore and nothing.
 */
let store: SpaceStore = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): SpaceStore => store

let pendingWrite: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced because a separator drag rewrites the active layout every frame,
 * and a synchronous `setItem` per frame is needless work for a value only the
 * next launch reads.
 */
function persist(next: SpaceStore): void {
  if (pendingWrite !== null) clearTimeout(pendingWrite)
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    try {
      localStorage.setItem(SPACES_STORAGE_KEY, serializeSpaceStore(next))
    } catch {
      // Best effort: the in-memory store is already the truth for this run.
    }
  }, 200)
}

function commit(next: SpaceStore): void {
  if (next === store) return
  store = next
  persist(next)
  for (const listener of listeners) listener()
}

/** The tab list and which tab is active. */
export function useSpaces(): SpaceStore {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** The same store, for the callers that are not components. */
export function spaceStoreSnapshot(): SpaceStore {
  return store
}

/**
 * The space rewrites, as the shell and the split facade call them. Module-level
 * and therefore identity-stable, so they can sit in dependency arrays without
 * churn.
 */
export const spaceActions = {
  /**
   * Opens a blank space at the end and focuses it — a new desktop, ready for a
   * fresh arrangement of panes.
   */
  create: (): void => commit(createSpace(store)),

  /** Closes a tab; the last tab empties instead of vanishing. */
  close: (spaceId: string): void => commit(closeSpace(store, spaceId)),

  select: (spaceId: string): void => commit(selectSpace(store, spaceId)),

  /** Direct tab jump, as `Mod+Alt+1…9` resolves. */
  selectAt: (index: number): void => commit(selectSpaceAt(store, index)),

  /** Cycles the tabs, wrapping at either end. */
  cycle: (delta: number): void => commit(cycleSpace(store, delta)),

  rename: (spaceId: string, name: string): void => commit(renameSpace(store, spaceId, name)),

  /** Drag-reorder: put `spaceId` in front of `beforeId`, or last when null. */
  move: (spaceId: string, beforeId: string | null): void =>
    commit(moveSpace(store, spaceId, beforeId)),

  /**
   * The composition seam the split facade builds on: one store rewrite, then a
   * single persist. Named `update` rather than exposing `commit` so the store
   * still owns debouncing and notification.
   */
  update: (fn: (current: SpaceStore) => SpaceStore): void => commit(fn(store)),

  /** Blanks sessions that no longer exist, in every space. */
  prune: (liveIds: ReadonlySet<string>): void => commit(pruneSpaceSessions(store, liveIds)),

  /** Test seam: forgets every space so each case starts from one blank pane. */
  reset: (): void => {
    if (pendingWrite !== null) {
      clearTimeout(pendingWrite)
      pendingWrite = null
    }
    commit(initialSpaceStore())
  },
}

/** The most tabs the store will hold; the shell greys out "+" at the ceiling. */
export { MAX_SPACES }
