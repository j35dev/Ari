import { describe, expect, it } from 'vitest'
import {
  MAX_PANES,
  activeSessionOf,
  assignSession,
  clampRatio,
  clearPane,
  closePane,
  directionForEdge,
  findLeaf,
  focusPane,
  initialLayout,
  leaves,
  openSessionInSplit,
  paneCount,
  paneIdForSession,
  parseLayout,
  pruneSessions,
  serializeLayout,
  sessionIdsInPanes,
  setRatio,
  splitPane,
  swapPanes,
  toggleZoom,
  type IdFactory,
  type PaneEdge,
  type PaneNode,
  type SplitLayout,
} from './split-layout'

/** Deterministic per-kind ids, so a fixture reads as `pane1 | pane2` under `split1`. */
function counter(): IdFactory {
  const seen: Record<'pane' | 'split', number> = { pane: 0, split: 0 }
  return (kind) => `${kind}${++seen[kind]}`
}

type Move =
  | { do: 'split'; pane: string; edge: PaneEdge }
  | { do: 'open'; pane: string; session: string; edge: PaneEdge }
  | { do: 'fill'; pane: string; session: string }

const split = (pane: string, edge: PaneEdge): Move => ({ do: 'split', pane, edge })
const open = (pane: string, session: string, edge: PaneEdge): Move => ({
  do: 'open',
  pane,
  session,
  edge,
})
const fill = (pane: string, session: string): Move => ({ do: 'fill', pane, session })

/**
 * Builds a layout by replaying moves over one fresh id sequence, so every test
 * gets the same predictable pane ids whichever fixtures it composes.
 */
function build(...moves: Move[]): SplitLayout {
  const newId = counter()
  let layout = initialLayout(newId)
  for (const move of moves) {
    if (move.do === 'split') layout = splitPane(layout, move.pane, move.edge, newId)
    else if (move.do === 'open') {
      layout = openSessionInSplit(layout, move.pane, move.session, move.edge, newId)
    } else layout = assignSession(layout, move.pane, move.session)
  }
  return layout
}

const paneIds = (layout: SplitLayout): string[] => leaves(layout.root).map((leaf) => leaf.paneId)
const shown = (layout: SplitLayout): (string | null)[] =>
  leaves(layout.root).map((leaf) => leaf.sessionId)

/** One pane: `pane1`. */
const one = (): SplitLayout => build()

/** `pane1` beside `pane2`, focus on the new right-hand pane. */
const two = (): SplitLayout => build(split('pane1', 'right'))

/** The reference shape: `pane1` full height beside `pane2` stacked over `pane3`. */
const stacked = (): SplitLayout => build(split('pane1', 'right'), split('pane2', 'below'))

/** `two()`, with `sA` on the left and `sB` on the right. */
const populated = (): SplitLayout =>
  build(split('pane1', 'right'), fill('pane1', 'sA'), fill('pane2', 'sB'))

/** All six panes, each split nested inside the last: `pane1` .. `pane6`. */
const full = (): SplitLayout =>
  build(...Array.from({ length: MAX_PANES - 1 }, () => split('pane1', 'below')))

describe('initialLayout', () => {
  it('starts with a single blank pane, focused and unzoomed', () => {
    const layout = one()
    expect(paneIds(layout)).toEqual(['pane1'])
    expect(shown(layout)).toEqual([null])
    expect(layout.focusedPaneId).toBe('pane1')
    expect(layout.zoomedPaneId).toBeNull()
    expect(paneCount(layout)).toBe(1)
  })
})

describe('splitPane', () => {
  it('puts the new blank pane on the requested side and focuses it', () => {
    const right = build(split('pane1', 'right'))
    expect(paneIds(right)).toEqual(['pane1', 'pane2'])
    expect(right.focusedPaneId).toBe('pane2')
    expect(shown(right)).toEqual([null, null])

    const left = build(split('pane1', 'left'))
    expect(paneIds(left)).toEqual(['pane2', 'pane1'])
  })

  it('derives the direction from the edge', () => {
    expect(directionForEdge('left')).toBe('row')
    expect(directionForEdge('right')).toBe('row')
    expect(directionForEdge('above')).toBe('column')
    expect(directionForEdge('below')).toBe('column')

    const above = build(split('pane1', 'above'))
    expect(above.root.kind === 'split' && above.root.direction).toBe('column')
    const below = build(split('pane1', 'below'))
    expect(below.root.kind === 'split' && below.root.direction).toBe('column')
  })

  it('starts an even split', () => {
    const layout = build(split('pane1', 'right'))
    expect(layout.root.kind === 'split' && layout.root.ratio).toBe(0.5)
  })

  it('nests: splitting the right pane of a row stacks inside the row', () => {
    const layout = stacked()
    expect(paneIds(layout)).toEqual(['pane1', 'pane2', 'pane3'])
    const root = layout.root
    expect(root.kind === 'split' && root.direction).toBe('row')
    expect(root.kind === 'split' && root.a.kind === 'leaf' && root.a.paneId).toBe('pane1')
    expect(root.kind === 'split' && root.b.kind === 'split' && root.b.direction).toBe('column')
  })

  it('refuses past the ceiling, leaving the layout identical', () => {
    const layout = full()
    expect(paneCount(layout)).toBe(MAX_PANES)
    expect(splitPane(layout, 'pane1', 'right')).toBe(layout)
  })

  it('clears zoom, since the tree just changed shape', () => {
    const zoomed = toggleZoom(two())
    expect(zoomed.zoomedPaneId).toBe('pane2')
    expect(splitPane(zoomed, 'pane1', 'right').zoomedPaneId).toBeNull()
  })

  it('ignores an unknown pane', () => {
    const layout = two()
    expect(splitPane(layout, 'nope', 'right')).toBe(layout)
  })
})

describe('assignSession', () => {
  it('fills a blank pane and focuses it', () => {
    const layout = build(split('pane1', 'right'), fill('pane1', 'sA'))
    expect(shown(layout)).toEqual(['sA', null])
    expect(layout.focusedPaneId).toBe('pane1')
  })

  it('never shows a session twice: the old pane goes blank, not away', () => {
    const moved = assignSession(populated(), 'pane1', 'sB')
    expect(shown(moved)).toEqual(['sB', null])
    expect(paneCount(moved)).toBe(2)
    expect(moved.focusedPaneId).toBe('pane1')
  })

  it('is a focus move when the session is already in that pane', () => {
    const again = assignSession(populated(), 'pane2', 'sB')
    expect(shown(again)).toEqual(['sA', 'sB'])
    expect(again.focusedPaneId).toBe('pane2')
  })

  it('ignores an unknown pane rather than focusing it', () => {
    const layout = populated()
    expect(assignSession(layout, 'nope', 'sC')).toBe(layout)
  })
})

describe('openSessionInSplit', () => {
  it('splits and fills in one move', () => {
    const layout = build(open('pane1', 'sA', 'right'))
    expect(paneIds(layout)).toEqual(['pane1', 'pane2'])
    expect(shown(layout)).toEqual([null, 'sA'])
    expect(layout.focusedPaneId).toBe('pane2')
  })

  it('focuses a session that is already open instead of duplicating it', () => {
    const layout = build(open('pane1', 'sA', 'right'))
    const again = openSessionInSplit(layout, 'pane1', 'sA', 'below')
    expect(paneCount(again)).toBe(2)
    expect(again.focusedPaneId).toBe('pane2')
  })

  it('is refused at the ceiling', () => {
    const layout = full()
    expect(openSessionInSplit(layout, 'pane1', 'sA', 'right')).toBe(layout)
    expect(shown(layout)).toEqual([null, null, null, null, null, null])
  })

  it('still focuses an open session at the ceiling', () => {
    const layout = assignSession(full(), 'pane1', 'sA')
    const focused = openSessionInSplit(layout, 'pane2', 'sA', 'right')
    expect(focused.focusedPaneId).toBe('pane1')
    expect(paneCount(focused)).toBe(MAX_PANES)
  })

  it('ignores an unknown pane', () => {
    const layout = one()
    expect(openSessionInSplit(layout, 'nope', 'sA', 'right')).toBe(layout)
  })
})

describe('swapPanes', () => {
  it('trades contents, keeping both panes where they are', () => {
    const swapped = swapPanes(populated(), 'pane2', 'pane1')
    expect(paneIds(swapped)).toEqual(['pane1', 'pane2'])
    expect(shown(swapped)).toEqual(['sB', 'sA'])
    expect(swapped.focusedPaneId).toBe('pane1')
  })

  it('swaps a blank pane with a filled one', () => {
    const layout = build(split('pane1', 'right'), fill('pane1', 'sA'))
    expect(shown(swapPanes(layout, 'pane2', 'pane1'))).toEqual([null, 'sA'])
  })

  it('is a no-op for the same pane, two blanks, or an unknown pane', () => {
    const layout = two()
    expect(swapPanes(layout, 'pane1', 'pane1')).toBe(layout)
    expect(swapPanes(layout, 'pane1', 'pane2')).toBe(layout)
    expect(swapPanes(layout, 'pane1', 'nope')).toBe(layout)
  })

  it('clears zoom', () => {
    expect(swapPanes(toggleZoom(populated()), 'pane1', 'pane2').zoomedPaneId).toBeNull()
  })
})

describe('closePane', () => {
  it('collapses the parent onto the sibling and focuses it', () => {
    const layout = closePane(stacked(), 'pane3')
    expect(paneIds(layout)).toEqual(['pane1', 'pane2'])
    expect(layout.focusedPaneId).toBe('pane2')
    expect(layout.root.kind === 'split' && layout.root.direction).toBe('row')
  })

  it('promotes a whole subtree when a whole side closes', () => {
    const layout = closePane(stacked(), 'pane1')
    expect(paneIds(layout)).toEqual(['pane2', 'pane3'])
    expect(layout.focusedPaneId).toBe('pane2')
    expect(layout.root.kind === 'split' && layout.root.direction).toBe('column')
  })

  it('empties the last pane rather than leaving the shell paneless', () => {
    const layout = closePane(build(fill('pane1', 'sA')), 'pane1')
    expect(paneCount(layout)).toBe(1)
    expect(shown(layout)).toEqual([null])
    expect(layout.focusedPaneId).toBe('pane1')
  })

  it('ignores an unknown pane', () => {
    const layout = stacked()
    expect(closePane(layout, 'nope')).toBe(layout)
  })

  it('clears zoom', () => {
    expect(closePane(toggleZoom(stacked()), 'pane3').zoomedPaneId).toBeNull()
  })
})

describe('focusPane', () => {
  it('moves focus and clears zoom when focus actually moves', () => {
    const layout = focusPane(stacked(), 'pane1')
    expect(layout.focusedPaneId).toBe('pane1')
    expect(focusPane(toggleZoom(layout), 'pane2').zoomedPaneId).toBeNull()
  })

  it('leaves zoom alone when the pane already has focus', () => {
    const layout = toggleZoom(stacked())
    expect(layout.zoomedPaneId).toBe('pane3')
    expect(focusPane(layout, 'pane3')).toBe(layout)
  })

  it('ignores an unknown pane', () => {
    const layout = stacked()
    expect(focusPane(layout, 'nope')).toBe(layout)
  })
})

describe('setRatio', () => {
  it('clamps to the usable band', () => {
    expect(clampRatio(0)).toBe(0.1)
    expect(clampRatio(1)).toBe(0.9)
    expect(clampRatio(Number.NaN)).toBe(0.5)
    expect(clampRatio(0.42)).toBe(0.42)

    const layout = setRatio(two(), 'split1', 5)
    expect(layout.root.kind === 'split' && layout.root.ratio).toBe(0.9)
  })

  it('touches only the named split, and keeps zoom', () => {
    const layout = setRatio(stacked(), 'split2', 0.3)
    const root = layout.root
    expect(root.kind === 'split' && root.ratio).toBe(0.5)
    expect(root.kind === 'split' && root.b.kind === 'split' && root.b.ratio).toBe(0.3)
    expect(setRatio(toggleZoom(two()), 'split1', 0.7).zoomedPaneId).toBe('pane2')
  })

  it('returns the same layout for an unknown split', () => {
    const layout = two()
    expect(setRatio(layout, 'nope', 0.3)).toBe(layout)
  })
})

describe('toggleZoom', () => {
  it('fills with the focused pane and restores it', () => {
    const layout = stacked()
    const zoomed = toggleZoom(layout)
    expect(zoomed.zoomedPaneId).toBe(zoomed.focusedPaneId)
    expect(toggleZoom(zoomed).zoomedPaneId).toBeNull()
  })

  it('has nothing to zoom with a single pane', () => {
    const layout = one()
    expect(toggleZoom(layout)).toBe(layout)
  })
})

describe('pruneSessions', () => {
  it('blanks panes whose session is gone and keeps the shape', () => {
    const layout = build(
      split('pane1', 'right'),
      split('pane2', 'below'),
      fill('pane1', 'sA'),
      fill('pane2', 'sB'),
    )
    const pruned = pruneSessions(layout, new Set(['sB']))
    expect(shown(pruned)).toEqual([null, 'sB', null])
    expect(paneCount(pruned)).toBe(3)
  })

  it('returns the same layout when every session is live', () => {
    const layout = build(split('pane1', 'right'), fill('pane1', 'sA'))
    expect(pruneSessions(layout, new Set(['sA']))).toBe(layout)
  })
})

describe('tree queries', () => {
  it('reads panes in order and finds them by id or by session', () => {
    const layout = build(
      split('pane1', 'right'),
      split('pane2', 'below'),
      fill('pane1', 'sA'),
      fill('pane3', 'sC'),
    )
    expect(paneIds(layout)).toEqual(['pane1', 'pane2', 'pane3'])
    expect(sessionIdsInPanes(layout)).toEqual(['sA', 'sC'])
    expect(paneIdForSession(layout, 'sC')).toBe('pane3')
    expect(paneIdForSession(layout, 'nope')).toBeNull()
    expect(findLeaf(layout.root, 'pane2')?.sessionId).toBeNull()
    expect(findLeaf(layout.root, 'nope')).toBeNull()
  })

  it('clears a pane in place', () => {
    const layout = build(split('pane1', 'right'), fill('pane1', 'sA'))
    expect(shown(clearPane(layout, 'pane1'))).toEqual([null, null])
    expect(clearPane(layout, 'pane2')).toBe(layout)
  })
})

describe('activeSessionOf', () => {
  it('is the focused pane session', () => {
    expect(activeSessionOf(populated())).toBe('sB')
    expect(activeSessionOf(assignSession(populated(), 'pane1', 'sA'))).toBe('sA')
  })

  it('falls back to the first pane showing anything while focus is blank', () => {
    const layout = assignSession(build(split('pane1', 'right'), fill('pane2', 'sB')), 'pane1', 'sA')
    expect(layout.focusedPaneId).toBe('pane1')
    expect(activeSessionOf(clearPane(layout, 'pane1'))).toBe('sB')
  })

  it('is null when no pane is showing anything', () => {
    expect(activeSessionOf(one())).toBeNull()
    expect(activeSessionOf(two())).toBeNull()
  })
})

describe('layout codec', () => {
  it('round-trips a layout', () => {
    const layout = setRatio(
      build(
        split('pane1', 'right'),
        split('pane2', 'below'),
        fill('pane1', 'sA'),
        fill('pane3', 'sC'),
      ),
      'split1',
      0.33,
    )
    expect(parseLayout(serializeLayout(layout))).toEqual(layout)
  })

  it('round-trips zoom', () => {
    const layout = toggleZoom(stacked())
    expect(parseLayout(serializeLayout(layout))?.zoomedPaneId).toBe(layout.focusedPaneId)
  })

  it('rejects what it cannot render', () => {
    const chain = (count: number): PaneNode => {
      let node: PaneNode = { kind: 'leaf', paneId: 'p0', sessionId: null }
      for (let i = 1; i < count; i++) {
        node = {
          kind: 'split',
          nodeId: `n${i}`,
          direction: 'row',
          ratio: 0.5,
          a: node,
          b: { kind: 'leaf', paneId: `p${i}`, sessionId: null },
        }
      }
      return node
    }
    const withRoot = (root: PaneNode): string =>
      JSON.stringify({ root, focusedPaneId: root.kind === 'leaf' ? root.paneId : 'p0' })
    const badLeaf = { kind: 'leaf', paneId: 'a', sessionId: 7 }
    const badSplit = (patch: Record<string, unknown>): string =>
      JSON.stringify({
        root: {
          kind: 'split',
          nodeId: 'n1',
          direction: 'row',
          ratio: 0.5,
          a: { kind: 'leaf', paneId: 'a', sessionId: null },
          b: { kind: 'leaf', paneId: 'b', sessionId: null },
          ...patch,
        },
      })

    expect(parseLayout(null)).toBeNull()
    expect(parseLayout('')).toBeNull()
    expect(parseLayout('{')).toBeNull()
    expect(parseLayout('[]')).toBeNull()
    expect(parseLayout('{}')).toBeNull()
    expect(parseLayout(JSON.stringify({ root: { kind: 'leaf', paneId: '' } }))).toBeNull()
    expect(parseLayout(JSON.stringify({ root: badLeaf }))).toBeNull()
    expect(parseLayout(withRoot(chain(MAX_PANES + 1)))).toBeNull()
    expect(parseLayout(badSplit({ direction: 'diagonal' }))).toBeNull()
    expect(parseLayout(badSplit({ ratio: 'half' }))).toBeNull()
    expect(parseLayout(badSplit({ kind: 'cluster' }))).toBeNull()
  })

  it('rejects a pane id or a session appearing twice', () => {
    const pair = (a: PaneNode, b: PaneNode): string =>
      JSON.stringify({
        root: { kind: 'split', nodeId: 'n1', direction: 'row', ratio: 0.5, a, b },
      })
    const leaf = (paneId: string, sessionId: string | null): PaneNode => ({
      kind: 'leaf',
      paneId,
      sessionId,
    })
    expect(parseLayout(pair(leaf('same', null), leaf('same', null)))).toBeNull()
    expect(parseLayout(pair(leaf('a', 'sA'), leaf('b', 'sA')))).toBeNull()
    expect(parseLayout(pair(leaf('a', 'sA'), leaf('b', 'sB')))).not.toBeNull()
  })

  it('repairs focus and zoom that name a pane the tree does not have', () => {
    const orphaned = parseLayout(
      JSON.stringify({ root: two().root, focusedPaneId: 'ghost', zoomedPaneId: 'ghost' }),
    )
    expect(orphaned?.focusedPaneId).toBe('pane1')
    expect(orphaned?.zoomedPaneId).toBeNull()
  })

  it('clamps a ratio that came back out of band', () => {
    const layout = parseLayout(
      JSON.stringify({
        root: {
          kind: 'split',
          nodeId: 'n1',
          direction: 'row',
          ratio: 12,
          a: { kind: 'leaf', paneId: 'a', sessionId: null },
          b: { kind: 'leaf', paneId: 'b', sessionId: null },
        },
      }),
    )
    expect(layout?.root.kind === 'split' && layout.root.ratio).toBe(0.9)
  })
})
