/**
 * Pure pane-tree algebra for the terminal workspace (M24.1): a binary tree of
 * splits in the tmux/herdr mould. Leaves are live terminals; splits divide
 * space between two children along an axis with a draggable ratio. Keeping
 * every operation a pure transform makes the geometry unit-testable without
 * mounting xterm.
 */

/** `row` places children side by side; `col` stacks them vertically. */
export type SplitDir = 'row' | 'col'

export type PaneNode =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'split'
      dir: SplitDir
      /** Fraction (0.15–0.85) of space given to the `a` child. */
      ratio: number
      /** Stable identity for resize targeting; derived from the new pane id. */
      splitId: string
      a: PaneNode
      b: PaneNode
    }

export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85

export function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * Replaces the leaf `paneId` with a split whose first child is the original
 * leaf and whose second is a fresh leaf. Returns null when the id is absent
 * (stale UI state); callers no-op on null.
 */
export function splitLeaf(
  root: PaneNode,
  paneId: string,
  dir: SplitDir,
  newPaneId: string,
): PaneNode | null {
  if (root.kind === 'leaf') {
    if (root.paneId !== paneId) return null
    return {
      kind: 'split',
      dir,
      ratio: 0.5,
      splitId: `split_${newPaneId}`,
      a: root,
      b: { kind: 'leaf', paneId: newPaneId },
    }
  }
  const a = splitLeaf(root.a, paneId, dir, newPaneId)
  if (a) return { ...root, a }
  const b = splitLeaf(root.b, paneId, dir, newPaneId)
  if (b) return { ...root, b }
  return null
}

/**
 * Removes the leaf `paneId`, promoting its sibling. Returns null when the
 * removed leaf was the root (the workspace becomes empty) or the id is absent.
 */
export function closeLeaf(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === 'leaf') return null
  if (root.a.kind === 'leaf' && root.a.paneId === paneId) return root.b
  if (root.b.kind === 'leaf' && root.b.paneId === paneId) return root.a
  const a = closeLeaf(root.a, paneId)
  if (a) return { ...root, a }
  const b = closeLeaf(root.b, paneId)
  if (b) return { ...root, b }
  return null
}

/** Immutably updates one split's ratio; unknown ids return the tree untouched. */
export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.kind === 'leaf') return root
  if (root.splitId === splitId) return { ...root, ratio: clampRatio(ratio) }
  const a = setRatio(root.a, splitId, ratio)
  if (a !== root.a) return { ...root, a }
  const b = setRatio(root.b, splitId, ratio)
  if (b !== root.b) return { ...root, b }
  return root
}

export function countLeaves(root: PaneNode): number {
  if (root.kind === 'leaf') return 1
  return countLeaves(root.a) + countLeaves(root.b)
}

/** First leaf in reading order — the fallback active pane after a close. */
export function firstLeafId(root: PaneNode | null): string | null {
  if (root === null) return null
  if (root.kind === 'leaf') return root.paneId
  return firstLeafId(root.a) ?? firstLeafId(root.b)
}

/** True when the tree contains the given leaf. */
export function hasLeaf(root: PaneNode | null, paneId: string): boolean {
  if (root === null) return false
  if (root.kind === 'leaf') return root.paneId === paneId
  return hasLeaf(root.a, paneId) || hasLeaf(root.b, paneId)
}
