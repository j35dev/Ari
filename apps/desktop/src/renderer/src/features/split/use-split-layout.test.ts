import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { leaves, sessionIdsInPanes, terminalIdsInPanes } from './split-layout'
import type { SplitLayout } from './split-layout'
import {
  activeLayoutOf,
  LEGACY_SPLIT_LAYOUT_STORAGE_KEY,
  parseSpaceStore,
  serializeSpaceStore,
  SPACES_STORAGE_KEY,
} from '../spaces'
import { spaceActions, spaceStoreSnapshot } from '../spaces/use-spaces'
import { splitLayoutActions, splitLayoutSnapshot } from './use-split-layout'

/** Adds a second pane to the right of the focused one and returns its id. */
function splitRight(): string {
  splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'right')
  return splitLayoutSnapshot().focusedPaneId
}

afterEach(() => {
  vi.useRealTimers()
})

describe('splitLayoutActions', () => {
  beforeEach(() => {
    splitLayoutActions.reset()
    localStorage.clear()
  })

  it('starts from a single blank pane, and resetting comes back to it', () => {
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(1)

    splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'below')
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(2)

    splitLayoutActions.reset()
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(1)
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual([])
  })

  it('finds the pane a session is already in, so a second click focuses it', () => {
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sA')
    const second = splitRight()

    expect(splitLayoutActions.paneOf('sA')).toBe(first)
    splitLayoutActions.assign(second, 'sA')

    // Moved, never shown twice: the pane it left is still there, now blank.
    expect(splitLayoutActions.paneOf('sA')).toBe(second)
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual(['sA'])
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(2)
  })

  it('reveals a session open in another space instead of pulling it out', () => {
    const home = spaceStoreSnapshot().activeSpaceId
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sA')
    const second = splitRight()
    splitLayoutActions.assign(second, 'sB')
    spaceActions.create()
    expect(spaceStoreSnapshot().activeSpaceId).not.toBe(home)

    expect(splitLayoutActions.reveal('sA')).toBe(true)

    // Back in the space that holds it, focused, with its neighbour untouched.
    expect(spaceStoreSnapshot().activeSpaceId).toBe(home)
    expect(splitLayoutSnapshot().focusedPaneId).toBe(splitLayoutActions.paneOf('sA'))
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual(['sA', 'sB'])
  })

  it('reports a session that no pane holds, so the caller can place it', () => {
    expect(splitLayoutActions.reveal('nowhere')).toBe(false)
  })

  it('leaves a session where it is when a full space refuses the split', () => {
    const home = spaceStoreSnapshot().activeSpaceId
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sA')
    spaceActions.create()
    // Fill the new space to the pane ceiling, every pane occupied.
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 's0')
    for (let i = 1; i < 6; i++) {
      splitLayoutActions.split(splitLayoutSnapshot().focusedPaneId, 'right')
      splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, `s${i}`)
    }
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(6)

    splitLayoutActions.openInSplit('sA', 'right')
    splitLayoutActions.dropSession(splitLayoutSnapshot().focusedPaneId, 'sA', 'right')

    expect(sessionIdsInPanes(splitLayoutSnapshot())).not.toContain('sA')
    spaceActions.select(home)
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual(['sA'])
  })

  it('focuses a session dropped beside a pane in the space it is already in', () => {
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sA')
    const second = splitRight()
    splitLayoutActions.assign(second, 'sB')

    splitLayoutActions.dropSession(second, 'sA', 'right')

    // Same two panes, same contents: the drop focused sA rather than moving it.
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(2)
    expect(splitLayoutActions.paneOf('sA')).toBe(first)
    expect(splitLayoutSnapshot().focusedPaneId).toBe(first)
  })

  it('closes a pane down to the last one, which empties instead of vanishing', () => {
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sA')
    const second = splitRight()
    splitLayoutActions.assign(second, 'sB')

    splitLayoutActions.close(second)
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(1)
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual(['sA'])

    splitLayoutActions.close(splitLayoutSnapshot().focusedPaneId)
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(1)
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual([])
  })

  it('assigns a terminal to a pane without showing it twice', () => {
    const first = splitLayoutSnapshot().focusedPaneId
    const second = splitRight()
    splitLayoutActions.assignTerminal(second, 'term_a')
    expect(terminalIdsInPanes(splitLayoutSnapshot())).toEqual(['term_a'])
    splitLayoutActions.assignTerminal(first, 'term_a')
    expect(terminalIdsInPanes(splitLayoutSnapshot())).toEqual(['term_a'])
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(2)
  })

  it('blanks the pane of a session that no longer exists, keeping the shape', () => {
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sA')
    const second = splitRight()
    splitLayoutActions.assign(second, 'sB')

    splitLayoutActions.prune(new Set(['sB']))
    expect(sessionIdsInPanes(splitLayoutSnapshot())).toEqual(['sB'])
    expect(leaves(splitLayoutSnapshot().root)).toHaveLength(2)
  })

  it('resizes the split a separator drag names', () => {
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sA')
    splitRight()
    const root = splitLayoutSnapshot().root
    if (root.kind !== 'split') throw new Error('splitting should have produced a split')

    splitLayoutActions.resize(root.nodeId, 0.25)
    const resized = splitLayoutSnapshot().root
    expect(resized.kind === 'split' && resized.ratio).toBe(0.25)

    // The separator reports a raw pointer share; the model is what clamps it.
    splitLayoutActions.resize(root.nodeId, 4)
    const clamped = splitLayoutSnapshot().root
    expect(clamped.kind === 'split' && clamped.ratio).toBe(0.9)
  })

  it('zooms the pane the menu was opened on, not the one that had focus', () => {
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sA')
    const second = splitRight()
    expect(second).not.toBe(first)

    splitLayoutActions.toggleZoom(first)
    expect(splitLayoutSnapshot().zoomedPaneId).toBe(first)
    expect(splitLayoutSnapshot().focusedPaneId).toBe(first)

    // The same pane's entry now reads Unzoom pane, and puts the split back.
    splitLayoutActions.toggleZoom(first)
    expect(splitLayoutSnapshot().zoomedPaneId).toBeNull()
  })

  it('persists the active space once a burst of edits settles, not on every one', () => {
    vi.useFakeTimers()
    const first = splitLayoutSnapshot().focusedPaneId
    splitLayoutActions.assign(first, 'sA')
    splitLayoutActions.split(first, 'right')
    splitLayoutActions.assign(splitLayoutSnapshot().focusedPaneId, 'sB')

    expect(localStorage.getItem(SPACES_STORAGE_KEY)).toBeNull()
    vi.advanceTimersByTime(200)
    const persisted = parseSpaceStore(localStorage.getItem(SPACES_STORAGE_KEY))
    expect(persisted === null ? null : activeLayoutOf(persisted).root).toEqual(
      splitLayoutSnapshot().root,
    )
  })
})

describe('split layout restore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /**
   * The store reads storage once, at module load — so re-importing it is what a
   * relaunch looks like from here.
   */
  async function relaunch(): Promise<{
    splitLayoutSnapshot: () => SplitLayout
  }> {
    vi.resetModules()
    return import('./use-split-layout')
  }

  const left = {
    root: {
      kind: 'split' as const,
      nodeId: 'split1',
      direction: 'row' as const,
      ratio: 0.5,
      a: { kind: 'leaf' as const, paneId: 'pane1', sessionId: 'sA' },
      b: { kind: 'leaf' as const, paneId: 'pane2', sessionId: null },
    },
    focusedPaneId: 'pane2',
    zoomedPaneId: null,
  }

  it('comes back to the panes the user left', async () => {
    localStorage.setItem(
      SPACES_STORAGE_KEY,
      serializeSpaceStore({
        spaces: [{ id: 'space-1', name: 'Space 1', layout: left }],
        activeSpaceId: 'space-1',
      }),
    )

    const store = await relaunch()
    expect(store.splitLayoutSnapshot()).toEqual(left)
  })

  it('wraps a pre-spaces layout as the first tab on upgrade', async () => {
    // A build without spaces wrote one bare layout; the store reads it as tab 1
    // so the upgrade keeps the panes the user left open.
    localStorage.setItem(LEGACY_SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(left))

    const store = await relaunch()
    expect(store.splitLayoutSnapshot()).toEqual(left)
  })

  it('starts clean rather than rendering a layout it cannot read', async () => {
    localStorage.setItem(
      SPACES_STORAGE_KEY,
      '{"version":1,"spaces":[{"id":"a","name":"A","layout":"{"}]}',
    )

    const store = await relaunch()
    expect(leaves(store.splitLayoutSnapshot().root)).toHaveLength(1)
  })
})
