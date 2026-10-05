/**
 * Spaces: named sets of panes the user flips between, like tmux windows. A
 * space owns one `SplitLayout`; the store owns the ordered list and which one
 * is on screen. The pane model itself is unchanged — this is the layer that
 * makes "the layout" a list instead of a singleton.
 *
 * Everything here is pure: the functions rebuild a `SpaceStore` and never touch
 * storage, React, or the module-level state in `use-spaces.ts`. That keeps the
 * tab arithmetic testable on its own — the same reason `split-layout.ts` has no
 * React in it.
 */

import {
  clearPane,
  initialLayout,
  paneIdForSession,
  paneIdForTerminal,
  parseLayout,
  pruneSessions,
  serializeLayout,
  type IdFactory,
  type SplitLayout,
} from '../split/split-layout'

/** Ceiling on simultaneous spaces. Each keeps a live pane tree. */
export const MAX_SPACES = 6

/** One named workspace: a pane layout plus the label its tab shows. */
export interface Space {
  id: string
  name: string
  layout: SplitLayout
}

export interface SpaceStore {
  spaces: Space[]
  activeSpaceId: string
}

/** Mints the ids spaces allocate. Injectable so tests stay deterministic. */
export type SpaceIdFactory = () => string

const randomSpaceId: SpaceIdFactory = () => `space-${Math.random().toString(36).slice(2, 10)}`

/** The first `Space N` label not already in use, so closing frees its number. */
export function nextSpaceName(spaces: readonly { name: string }[]): string {
  const used = new Set(spaces.map((space) => space.name))
  for (let n = 1; ; n += 1) {
    const candidate = `Space ${String(n)}`
    if (!used.has(candidate)) return candidate
  }
}

function makeSpace(id: string, name: string, newPaneId?: IdFactory): Space {
  return { id, name, layout: initialLayout(newPaneId) }
}

/** A shell with nothing open: one space, one blank pane. */
export function initialSpaceStore(
  newSpaceId: SpaceIdFactory = randomSpaceId,
  newPaneId?: IdFactory,
): SpaceStore {
  const id = newSpaceId()
  return { spaces: [makeSpace(id, 'Space 1', newPaneId)], activeSpaceId: id }
}

/** The space on screen. The list is never empty, so this always answers. */
export function activeSpaceOf(store: SpaceStore): Space {
  return store.spaces.find((space) => space.id === store.activeSpaceId) ?? store.spaces[0]!
}

/** The pane layout the shell renders — the active space's. */
export function activeLayoutOf(store: SpaceStore): SplitLayout {
  return activeSpaceOf(store).layout
}

export function spaceById(store: SpaceStore, spaceId: string): Space | null {
  return store.spaces.find((space) => space.id === spaceId) ?? null
}

/**
 * Adds a blank space at the end and focuses it. At {@link MAX_SPACES} this is a
 * refusal, never a silent close of somebody's space.
 */
export function createSpace(
  store: SpaceStore,
  newSpaceId: SpaceIdFactory = randomSpaceId,
  newPaneId?: IdFactory,
): SpaceStore {
  if (store.spaces.length >= MAX_SPACES) return store
  const id = newSpaceId()
  const space = makeSpace(id, nextSpaceName(store.spaces), newPaneId)
  return { spaces: [...store.spaces, space], activeSpaceId: id }
}

/**
 * Removes a space. Closing the last one empties it instead, the way closing the
 * last pane empties that pane rather than leaving the shell with no surface.
 * Closing the active space activates the tab that slid into its slot, or the
 * new last tab when it was the rightmost — so the selection never lands beside
 * the one that closed.
 */
export function closeSpace(store: SpaceStore, spaceId: string, newPaneId?: IdFactory): SpaceStore {
  const index = store.spaces.findIndex((space) => space.id === spaceId)
  if (index === -1) return store
  const closing = store.spaces[index]!
  if (store.spaces.length === 1) {
    const emptied: Space = { ...closing, layout: initialLayout(newPaneId) }
    return { spaces: [emptied], activeSpaceId: emptied.id }
  }
  const spaces = store.spaces.filter((space) => space.id !== spaceId)
  const activeSpaceId =
    store.activeSpaceId === spaceId
      ? (spaces[Math.min(index, spaces.length - 1)]?.id ?? spaces[0]!.id)
      : store.activeSpaceId
  return { spaces, activeSpaceId }
}

export function selectSpace(store: SpaceStore, spaceId: string): SpaceStore {
  if (store.activeSpaceId === spaceId) return store
  if (!store.spaces.some((space) => space.id === spaceId)) return store
  return { ...store, activeSpaceId: spaceId }
}

export function selectSpaceAt(store: SpaceStore, index: number): SpaceStore {
  const space = store.spaces[index]
  return space === undefined ? store : selectSpace(store, space.id)
}

/** Steps through the tabs, wrapping at either end. */
export function cycleSpace(store: SpaceStore, delta: number): SpaceStore {
  if (store.spaces.length <= 1 || delta === 0) return store
  const index = store.spaces.findIndex((space) => space.id === store.activeSpaceId)
  const count = store.spaces.length
  const next = store.spaces[(((index + delta) % count) + count) % count]
  return next === undefined ? store : selectSpace(store, next.id)
}

export function renameSpace(store: SpaceStore, spaceId: string, name: string): SpaceStore {
  const trimmed = name.trim()
  if (trimmed === '') return store
  let changed = false
  const spaces = store.spaces.map((space) => {
    if (space.id !== spaceId || space.name === trimmed) return space
    changed = true
    return { ...space, name: trimmed }
  })
  return changed ? { ...store, spaces } : store
}

/** Replaces one space's pane tree; identity is preserved for untouched spaces. */
export function setSpaceLayout(
  store: SpaceStore,
  spaceId: string,
  layout: SplitLayout,
): SpaceStore {
  let changed = false
  const spaces = store.spaces.map((space) => {
    if (space.id !== spaceId || space.layout === layout) return space
    changed = true
    return { ...space, layout }
  })
  return changed ? { ...store, spaces } : store
}

/** Rewrites the active space's pane tree — where every pane action lands. */
export function updateActiveLayoutOf(
  store: SpaceStore,
  fn: (layout: SplitLayout) => SplitLayout,
): SpaceStore {
  const space = activeSpaceOf(store)
  return setSpaceLayout(store, space.id, fn(space.layout))
}

/**
 * Moves a tab. `beforeId` names the tab the dragged one should land in front
 * of; null drops it last. A move that changes nothing returns the same store.
 */
export function moveSpace(store: SpaceStore, spaceId: string, beforeId: string | null): SpaceStore {
  const from = store.spaces.findIndex((space) => space.id === spaceId)
  if (from === -1) return store
  const moving = store.spaces[from]!
  const without = store.spaces.filter((space) => space.id !== spaceId)
  const to =
    beforeId === null ? without.length : without.findIndex((space) => space.id === beforeId)
  if (to === -1) return store
  const spaces = [...without.slice(0, to), moving, ...without.slice(to)]
  if (spaces.every((space, i) => space.id === store.spaces[i]?.id)) return store
  return { ...store, spaces }
}

/**
 * Blanks a session everywhere it is shown, across every space. A session lives
 * in exactly one pane — the rule {@link assignSession} enforces within a layout,
 * extended to the whole store so a tab switch cannot reveal the same chat twice.
 */
export function withoutSession(store: SpaceStore, sessionId: string): SpaceStore {
  let changed = false
  const spaces = store.spaces.map((space) => {
    const paneId = paneIdForSession(space.layout, sessionId)
    if (paneId === null) return space
    changed = true
    return { ...space, layout: clearPane(space.layout, paneId) }
  })
  return changed ? { ...store, spaces } : store
}

/** The terminal counterpart of {@link withoutSession}. */
export function withoutTerminal(store: SpaceStore, terminalId: string): SpaceStore {
  let changed = false
  const spaces = store.spaces.map((space) => {
    const paneId = paneIdForTerminal(space.layout, terminalId)
    if (paneId === null) return space
    changed = true
    return { ...space, layout: clearPane(space.layout, paneId) }
  })
  return changed ? { ...store, spaces } : store
}

/** Blanks panes whose session is gone, keeping each space's shape. */
export function pruneSpaceSessions(store: SpaceStore, liveIds: ReadonlySet<string>): SpaceStore {
  let changed = false
  const spaces = store.spaces.map((space) => {
    const layout = pruneSessions(space.layout, liveIds)
    if (layout === space.layout) return space
    changed = true
    return { ...space, layout }
  })
  return changed ? { ...store, spaces } : store
}

export function serializeSpaceStore(store: SpaceStore): string {
  return JSON.stringify({
    version: 1,
    activeSpaceId: store.activeSpaceId,
    spaces: store.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      layout: serializeLayout(space.layout),
    })),
  })
}

function parseSpaceEntry(value: unknown): Space | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const { id, name, layout } = row
  if (typeof id !== 'string' || id === '') return null
  if (typeof name !== 'string' || name === '') return null
  if (typeof layout !== 'string') return null
  const parsed = parseLayout(layout)
  return parsed === null ? null : { id, name, layout: parsed }
}

/**
 * Reads a persisted space list. Anything that would leave the store
 * inconsistent — bad JSON, no spaces, more than {@link MAX_SPACES}, duplicate
 * ids, a layout the pane parser rejects — comes back null so the shell starts
 * clean rather than rendering a tab it cannot address.
 */
export function parseSpaceStore(raw: string | null): SpaceStore | null {
  if (raw === null || raw === '') return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  if (decoded === null || typeof decoded !== 'object') return null
  const value = decoded as Record<string, unknown>
  const rawSpaces = value['spaces']
  if (!Array.isArray(rawSpaces) || rawSpaces.length === 0 || rawSpaces.length > MAX_SPACES) {
    return null
  }
  const spaces: Space[] = []
  for (const entry of rawSpaces) {
    const space = parseSpaceEntry(entry)
    if (space === null) return null
    spaces.push(space)
  }
  if (new Set(spaces.map((space) => space.id)).size !== spaces.length) return null
  const active = value['activeSpaceId']
  const activeSpaceId =
    typeof active === 'string' && spaces.some((space) => space.id === active)
      ? active
      : spaces[0]!.id
  return { spaces, activeSpaceId }
}

/** The single-layout store a pre-spaces `ari.split.layout` value becomes. */
export function parseLegacyLayout(raw: string | null): SpaceStore | null {
  const layout = parseLayout(raw)
  if (layout === null) return null
  return { spaces: [{ id: 'space-1', name: 'Space 1', layout }], activeSpaceId: 'space-1' }
}
