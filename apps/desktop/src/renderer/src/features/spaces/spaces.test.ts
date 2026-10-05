import { describe, expect, it } from 'vitest'
import {
  activeLayoutOf,
  activeSpaceOf,
  closeSpace,
  createSpace,
  cycleSpace,
  initialSpaceStore,
  MAX_SPACES,
  moveSpace,
  nextSpaceName,
  parseLegacyLayout,
  parseSpaceStore,
  pruneSpaceSessions,
  renameSpace,
  selectSpace,
  selectSpaceAt,
  serializeSpaceStore,
  setSpaceLayout,
  updateActiveLayoutOf,
  withoutSession,
  withoutTerminal,
  type SpaceStore,
} from './spaces'
import {
  activePaneOf,
  assignSession,
  assignTerminal,
  leaves,
  pruneSessions,
  splitPane,
  type IdFactory,
} from '../split/split-layout'

/** A monotonic id source, so every case is deterministic. */
function counter(prefix: string): () => string {
  let n = 0
  return () => {
    n += 1
    return `${prefix}${String(n)}`
  }
}

function paneIds(): IdFactory {
  let n = 0
  return (kind) => {
    n += 1
    return `${kind}${String(n)}`
  }
}

function freshStore(): { store: SpaceStore; spaceId: () => string; paneId: IdFactory } {
  const spaceId = counter('space')
  const paneId = paneIds()
  return { store: initialSpaceStore(spaceId, paneId), spaceId, paneId }
}

function layoutOf(store: SpaceStore, spaceId: string) {
  return store.spaces.find((space) => space.id === spaceId)!.layout
}

function sessionIds(store: SpaceStore, spaceId: string): (string | null)[] {
  return leaves(layoutOf(store, spaceId).root).map((leaf) => leaf.sessionId)
}

function putSession(store: SpaceStore, spaceId: string, sessionId: string): SpaceStore {
  const layout = layoutOf(store, spaceId)
  return setSpaceLayout(store, spaceId, assignSession(layout, activePaneOf(layout), sessionId))
}

describe('space store model', () => {
  it('starts from one blank space', () => {
    const { store } = freshStore()
    expect(store.spaces).toHaveLength(1)
    expect(store.spaces[0]!.name).toBe('Space 1')
    expect(store.activeSpaceId).toBe('space1')
    expect(activeLayoutOf(store).root).toMatchObject({ kind: 'leaf', sessionId: null })
  })

  it('appends a blank space and focuses it', () => {
    const { store, spaceId, paneId } = freshStore()
    const next = createSpace(store, spaceId, paneId)

    expect(next.spaces.map((space) => space.name)).toEqual(['Space 1', 'Space 2'])
    expect(next.activeSpaceId).toBe('space2')
    expect(activeSpaceOf(next).layout.root).toMatchObject({ kind: 'leaf', sessionId: null })
    // The first space's layout is left alone.
    expect(next.spaces[0]!.layout).toBe(store.spaces[0]!.layout)
  })

  it('refuses to grow past the ceiling without touching the store', () => {
    const { store: first, spaceId, paneId } = freshStore()
    let store = first
    for (let i = 1; i < MAX_SPACES; i += 1) store = createSpace(store, spaceId, paneId)
    expect(store.spaces).toHaveLength(MAX_SPACES)
    expect(createSpace(store, spaceId, paneId)).toBe(store)
  })

  it('names a new space with the first free number', () => {
    expect(nextSpaceName([{ name: 'Space 1' }, { name: 'Space 3' }])).toBe('Space 2')
    expect(nextSpaceName([])).toBe('Space 1')
  })

  it('closes a middle tab and focuses the one that takes its slot', () => {
    const { store: first, spaceId, paneId } = freshStore()
    let store = createSpace(createSpace(first, spaceId, paneId), spaceId, paneId)
    store = selectSpace(store, 'space2')

    const next = closeSpace(store, 'space2', paneId)
    expect(next.spaces.map((space) => space.name)).toEqual(['Space 1', 'Space 3'])
    expect(next.activeSpaceId).toBe('space3')
  })

  it('closing the active last tab focuses the new last one', () => {
    const { store: first, spaceId, paneId } = freshStore()
    const store = createSpace(createSpace(first, spaceId, paneId), spaceId, paneId)
    // space3 is active already.

    const next = closeSpace(store, 'space3', paneId)
    expect(next.spaces.map((space) => space.name)).toEqual(['Space 1', 'Space 2'])
    expect(next.activeSpaceId).toBe('space2')
  })

  it('empties the only space instead of removing it', () => {
    const { store, paneId } = freshStore()
    const withSplit = updateActiveLayoutOf(store, (layout) =>
      splitPane(layout, activePaneOf(layout), 'right'),
    )
    expect(leaves(activeLayoutOf(withSplit).root)).toHaveLength(2)

    const emptied = closeSpace(withSplit, 'space1', paneId)
    expect(emptied.spaces).toHaveLength(1)
    expect(emptied.spaces[0]!.id).toBe('space1')
    expect(leaves(activeLayoutOf(emptied).root)).toHaveLength(1)
  })

  it('selects, jumps and cycles, wrapping at either end', () => {
    const { store: first, spaceId, paneId } = freshStore()
    const store = createSpace(createSpace(first, spaceId, paneId), spaceId, paneId)
    expect(store.activeSpaceId).toBe('space3')

    expect(activeSpaceOf(cycleSpace(store, 1)).name).toBe('Space 1')
    expect(activeSpaceOf(cycleSpace(store, -1)).name).toBe('Space 2')
    expect(activeSpaceOf(selectSpaceAt(store, 0)).name).toBe('Space 1')
    expect(selectSpaceAt(store, 9)).toBe(store)
    expect(cycleSpace(store, 0)).toBe(store)
  })

  it('renames, trimming and ignoring an empty name', () => {
    const { store } = freshStore()
    expect(renameSpace(store, 'space1', '  Deep work  ').spaces[0]!.name).toBe('Deep work')
    expect(renameSpace(store, 'space1', '   ')).toBe(store)
    expect(renameSpace(store, 'space1', 'Space 1')).toBe(store)
  })

  it('reorders tabs around the target, and leaves a no-op alone', () => {
    const { store: first, spaceId, paneId } = freshStore()
    const store = createSpace(createSpace(first, spaceId, paneId), spaceId, paneId)

    expect(moveSpace(store, 'space1', 'space3').spaces.map((s) => s.id)).toEqual([
      'space2',
      'space1',
      'space3',
    ])
    expect(moveSpace(store, 'space1', null).spaces.map((s) => s.id)).toEqual([
      'space2',
      'space3',
      'space1',
    ])
    expect(moveSpace(store, 'space1', 'space2')).toBe(store)
    expect(moveSpace(store, 'missing', null)).toBe(store)
  })

  it('rewrites only the active space when its layout changes', () => {
    const { store: first, spaceId, paneId } = freshStore()
    const store = createSpace(first, spaceId, paneId)
    const next = updateActiveLayoutOf(store, (layout) =>
      splitPane(layout, activePaneOf(layout), 'right'),
    )

    expect(leaves(activeLayoutOf(next).root)).toHaveLength(2)
    expect(leaves(next.spaces[0]!.layout.root)).toHaveLength(1)
  })

  it('blanks a session everywhere it is shown, once assigned', () => {
    const { store: first, spaceId, paneId } = freshStore()
    let store = createSpace(first, spaceId, paneId)
    store = putSession(store, 'space1', 'sA')
    store = putSession(store, 'space2', 'sA')
    expect(sessionIds(store, 'space1')).toEqual(['sA'])
    expect(sessionIds(store, 'space2')).toEqual(['sA'])

    const cleared = withoutSession(store, 'sA')
    expect(sessionIds(cleared, 'space1')).toEqual([null])
    expect(sessionIds(cleared, 'space2')).toEqual([null])
    expect(sessionIds(cleared, 'space1')).not.toEqual(['sA'])
    expect(withoutSession(cleared, 'sA')).toBe(cleared)
  })

  it('blanks a terminal everywhere it is shown too', () => {
    const { store: first, spaceId, paneId } = freshStore()
    const store = createSpace(first, spaceId, paneId)
    const withTerminal = updateActiveLayoutOf(store, (layout) =>
      assignTerminal(layout, activePaneOf(layout), 'term_a'),
    )
    const cleared = withoutTerminal(withTerminal, 'term_a')
    expect(leaves(activeLayoutOf(cleared).root).map((leaf) => leaf.terminalId ?? null)).toEqual([
      null,
    ])
    expect(withoutTerminal(cleared, 'term_a')).toBe(cleared)
  })

  it('prunes a dead session in every space, keeping each shape', () => {
    const { store: first, spaceId, paneId } = freshStore()
    let store = createSpace(first, spaceId, paneId)
    store = putSession(store, 'space1', 'sA')
    store = putSession(store, 'space2', 'sB')

    const pruned = pruneSpaceSessions(store, new Set(['sB']))
    expect(sessionIds(pruned, 'space1')).toEqual([null])
    expect(sessionIds(pruned, 'space2')).toEqual(['sB'])
    expect(pruneSpaceSessions(pruned, new Set(['sB']))).toBe(pruned)
    // pruneSessions is the per-layout primitive this wraps.
    expect(leaves(pruneSessions(layoutOf(store, 'space1'), new Set()).root)).toHaveLength(1)
  })
})

describe('space store persistence', () => {
  it('round-trips through serialize and parse', () => {
    const { store: first, spaceId, paneId } = freshStore()
    let store = createSpace(first, spaceId, paneId)
    store = putSession(store, 'space1', 'sA')

    const restored = parseSpaceStore(serializeSpaceStore(store))
    expect(restored).toEqual(store)
  })

  it('rejects anything that would leave the store inconsistent', () => {
    const { store } = freshStore()
    const good = JSON.parse(serializeSpaceStore(store)) as {
      spaces: { layout: string }[]
      activeSpaceId: string
    }

    expect(parseSpaceStore(null)).toBeNull()
    expect(parseSpaceStore('')).toBeNull()
    expect(parseSpaceStore('not json')).toBeNull()
    expect(parseSpaceStore('[]')).toBeNull()
    expect(parseSpaceStore('{"version":1,"spaces":[]}')).toBeNull()
    expect(
      parseSpaceStore(JSON.stringify({ version: 1, spaces: [good.spaces[0], good.spaces[0]] })),
    ).toBeNull()
    expect(
      parseSpaceStore(
        JSON.stringify({ version: 1, spaces: [{ id: 'a', name: 'A', layout: '{' }] }),
      ),
    ).toBeNull()
  })

  it('falls back to the first tab when the active id is unknown', () => {
    const { store } = freshStore()
    const decoded = JSON.parse(serializeSpaceStore(store)) as Record<string, unknown>
    decoded['activeSpaceId'] = 'ghost'

    const restored = parseSpaceStore(JSON.stringify(decoded))
    expect(restored?.activeSpaceId).toBe(store.spaces[0]!.id)
  })

  it('wraps a single pre-spaces layout as the first tab', () => {
    const { store } = freshStore()
    const layout = activeLayoutOf(store)
    const migrated = parseLegacyLayout(JSON.stringify(layout))

    expect(migrated?.spaces).toHaveLength(1)
    expect(migrated?.activeSpaceId).toBe('space-1')
    expect(migrated?.spaces[0]!.layout).toEqual(layout)
    expect(parseLegacyLayout('{"root":{"kind":"cluster"}}')).toBeNull()
  })
})
