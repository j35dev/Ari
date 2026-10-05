import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeLayoutOf, parseSpaceStore, serializeSpaceStore, type SpaceStore } from './spaces'
import {
  LEGACY_SPLIT_LAYOUT_STORAGE_KEY,
  SPACES_STORAGE_KEY,
  spaceActions,
  spaceStoreSnapshot,
} from './use-spaces'

afterEach(() => {
  vi.useRealTimers()
})

describe('spaceActions', () => {
  beforeEach(() => {
    localStorage.clear()
    spaceActions.reset()
  })

  it('starts from one blank space, and resetting returns to it', () => {
    expect(spaceStoreSnapshot().spaces).toHaveLength(1)

    spaceActions.create()
    expect(spaceStoreSnapshot().spaces).toHaveLength(2)
    expect(spaceStoreSnapshot().activeSpaceId).toBe(spaceStoreSnapshot().spaces[1]!.id)

    spaceActions.reset()
    expect(spaceStoreSnapshot().spaces).toHaveLength(1)
  })

  it('switches between tabs by id, index and cycle', () => {
    spaceActions.create()
    spaceActions.create()
    const [first, second, third] = spaceStoreSnapshot().spaces.map((space) => space.id)

    spaceActions.select(first!)
    expect(spaceStoreSnapshot().activeSpaceId).toBe(first)

    spaceActions.selectAt(1)
    expect(spaceStoreSnapshot().activeSpaceId).toBe(second)

    spaceActions.cycle(1)
    expect(spaceStoreSnapshot().activeSpaceId).toBe(third)
    spaceActions.cycle(1)
    expect(spaceStoreSnapshot().activeSpaceId).toBe(first)
  })

  it('closes a tab and keeps the last one alive as an empty surface', () => {
    spaceActions.create()
    const closing = spaceStoreSnapshot().activeSpaceId

    spaceActions.close(closing)
    expect(spaceStoreSnapshot().spaces).toHaveLength(1)

    spaceActions.close(spaceStoreSnapshot().activeSpaceId)
    expect(spaceStoreSnapshot().spaces).toHaveLength(1)
    expect(activeLayoutOf(spaceStoreSnapshot()).root).toMatchObject({
      kind: 'leaf',
      sessionId: null,
    })
  })

  it('renames and reorders through the store', () => {
    spaceActions.create()
    const [first, second] = spaceStoreSnapshot().spaces.map((space) => space.id)

    spaceActions.rename(first!, 'Focus')
    expect(spaceStoreSnapshot().spaces[0]!.name).toBe('Focus')

    spaceActions.move(first!, null)
    expect(spaceStoreSnapshot().spaces.map((space) => space.id)).toEqual([second, first])
  })

  it('applies a composed rewrite to the active space only', () => {
    spaceActions.create()
    const active = spaceStoreSnapshot().activeSpaceId
    const other = spaceStoreSnapshot().spaces[0]!.id

    spaceActions.update((store) => ({
      ...store,
      spaces: store.spaces.map((space) =>
        space.id === active ? { ...space, name: 'Renamed' } : space,
      ),
    }))

    expect(spaceStoreSnapshot().spaces.find((space) => space.id === active)!.name).toBe('Renamed')
    expect(spaceStoreSnapshot().spaces.find((space) => space.id === other)!.name).toBe('Space 1')
  })

  it('persists once a burst of edits settles, not on every one', () => {
    vi.useFakeTimers()
    spaceActions.create()
    spaceActions.selectAt(0)

    expect(localStorage.getItem(SPACES_STORAGE_KEY)).toBeNull()
    vi.advanceTimersByTime(200)
    const persisted = parseSpaceStore(localStorage.getItem(SPACES_STORAGE_KEY))
    expect(persisted?.spaces).toHaveLength(2)
  })

  it('drops a pending write when the store is reset', () => {
    vi.useFakeTimers()
    spaceActions.create()
    spaceActions.reset()
    vi.advanceTimersByTime(200)

    const persisted = parseSpaceStore(localStorage.getItem(SPACES_STORAGE_KEY))
    expect(persisted?.spaces).toHaveLength(1)
  })
})

describe('space store restore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** The store reads storage once, at module load — re-importing is a relaunch. */
  async function relaunch(): Promise<{ spaceStoreSnapshot: () => SpaceStore }> {
    vi.resetModules()
    return import('./use-spaces')
  }

  it('comes back to the tabs the user left', async () => {
    const left: SpaceStore = {
      spaces: [
        {
          id: 'space-1',
          name: 'One',
          layout: {
            root: { kind: 'leaf', paneId: 'p1', sessionId: 'sA' },
            focusedPaneId: 'p1',
            zoomedPaneId: null,
          },
        },
        {
          id: 'space-2',
          name: 'Two',
          layout: {
            root: { kind: 'leaf', paneId: 'p2', sessionId: null },
            focusedPaneId: 'p2',
            zoomedPaneId: null,
          },
        },
      ],
      activeSpaceId: 'space-2',
    }
    localStorage.setItem(SPACES_STORAGE_KEY, serializeSpaceStore(left))

    const store = await relaunch()
    expect(store.spaceStoreSnapshot()).toEqual(left)
  })

  it('wraps a pre-spaces layout as the first tab on upgrade', async () => {
    const layout = {
      root: { kind: 'leaf', paneId: 'p1', sessionId: 'sA' },
      focusedPaneId: 'p1',
      zoomedPaneId: null,
    }
    localStorage.setItem(LEGACY_SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(layout))

    const store = await relaunch()
    const restored = store.spaceStoreSnapshot()
    expect(restored.spaces).toHaveLength(1)
    expect(activeLayoutOf(restored)).toEqual(layout)
  })

  it('prefers the spaces key over a leftover legacy layout', async () => {
    localStorage.setItem(LEGACY_SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify({ root: null }))
    localStorage.setItem(
      SPACES_STORAGE_KEY,
      serializeSpaceStore({
        spaces: [
          {
            id: 'space-9',
            name: 'Current',
            layout: {
              root: { kind: 'leaf', paneId: 'p9', sessionId: null },
              focusedPaneId: 'p9',
              zoomedPaneId: null,
            },
          },
        ],
        activeSpaceId: 'space-9',
      }),
    )

    const store = await relaunch()
    expect(store.spaceStoreSnapshot().spaces[0]!.name).toBe('Current')
  })

  it('starts clean when the stored spaces cannot be read', async () => {
    localStorage.setItem(SPACES_STORAGE_KEY, '{"version":1,"spaces":"nope"}')

    const store = await relaunch()
    expect(store.spaceStoreSnapshot().spaces).toHaveLength(1)
  })
})
