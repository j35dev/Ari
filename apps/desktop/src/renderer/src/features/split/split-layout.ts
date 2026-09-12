/**
 * Split-view layout: a binary tree of panes, and the pure rewrites that move
 * sessions between them (split, swap, close, resize, prune).
 *
 * A leaf is one pane showing one session — or no session at all, which is the
 * blank pane a fresh "Split right" / "Split down" creates for the user to drop
 * something into. An interior node is a split: `row` places its two children
 * side by side, `column` stacks them, and `ratio` is the share the leading
 * child takes. Both shapes the reference layout uses come out of that — a pane
 * beside a column of two panes is a row split whose second child is a column
 * split — and every operation stays a local tree rewrite.
 *
 * Pane identity is deliberately separate from session identity so a blank pane
 * can exist and so swapping two panes never has to recreate leaves.
 */

/** Ceiling on simultaneously visible panes. */
export const MAX_PANES = 6

/** Where a new pane goes relative to an existing one. */
export type PaneEdge = 'left' | 'right' | 'above' | 'below'

/** `row` lays its children out side by side; `column` stacks them. */
export type SplitDirection = 'row' | 'column'

export interface PaneLeaf {
  kind: 'leaf'
  paneId: string
  /** The session on screen; null is the blank pane a split just created. */
  sessionId: string | null
}

export interface PaneSplit {
  kind: 'split'
  nodeId: string
  direction: SplitDirection
  /** Share of the leading child, 0..1. */
  ratio: number
  a: PaneNode
  b: PaneNode
}

export type PaneNode = PaneLeaf | PaneSplit

export interface SplitLayout {
  root: PaneNode
  focusedPaneId: string
  /** A pane filling the whole area on its own; cleared when the tree changes shape. */
  zoomedPaneId: string | null
}

/** Mints the ids a split allocates. Injectable so tests stay deterministic. */
export type IdFactory = (kind: 'pane' | 'split') => string

/** Below this a pane is unusably thin; above it, the trailing pane is. */
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9

/** Fresh ids must not collide with a layout restored from a previous launch. */
const randomId: IdFactory = (kind) => `${kind}-${Math.random().toString(36).slice(2, 10)}`

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

export function directionForEdge(edge: PaneEdge): SplitDirection {
  return edge === 'left' || edge === 'right' ? 'row' : 'column'
}

/** The layout a shell with nothing open starts from: one pane, no session. */
export function initialLayout(newId: IdFactory = randomId): SplitLayout {
  const paneId = newId('pane')
  return {
    root: { kind: 'leaf', paneId, sessionId: null },
    focusedPaneId: paneId,
    zoomedPaneId: null,
  }
}

/** Every pane in the tree, in reading order (leading child first). */
export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

export function paneCount(layout: SplitLayout): number {
  return leaves(layout.root).length
}

export function firstLeaf(node: PaneNode): PaneLeaf {
  return node.kind === 'leaf' ? node : firstLeaf(node.a)
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  for (const leaf of leaves(node)) if (leaf.paneId === paneId) return leaf
  return null
}

/** Non-null sessions on screen, in reading order. */
export function sessionIdsInPanes(layout: SplitLayout): string[] {
  return leaves(layout.root)
    .map((leaf) => leaf.sessionId)
    .filter((id): id is string => id !== null)
}

/** The pane showing `sessionId`, or null when it is not open. */
export function paneIdForSession(layout: SplitLayout, sessionId: string): string | null {
  return leaves(layout.root).find((leaf) => leaf.sessionId === sessionId)?.paneId ?? null
}

/**
 * The session the shell treats as active: the focused pane's, or the first
 * pane showing anything when the focused pane is blank. Deriving it is what
 * keeps the single-session consumers — workspace lookup, changes view, the
 * sidebar's highlighted row — following the pane the user is actually in.
 */
export function activeSessionOf(layout: SplitLayout): string | null {
  const focused = findLeaf(layout.root, layout.focusedPaneId)
  if (focused?.sessionId != null) return focused.sessionId
  for (const leaf of leaves(layout.root)) {
    if (leaf.sessionId !== null) return leaf.sessionId
  }
  return null
}

/**
 * The pane the user is actually in. A zoom hides every other pane, so it wins
 * over the focus: the pane filling the area is the one the keyboard and the
 * palette act on.
 */
export function activePaneOf(layout: SplitLayout): string {
  return layout.zoomedPaneId ?? layout.focusedPaneId
}

function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  return node.kind === 'leaf'
    ? fn(node)
    : { ...node, a: mapLeaves(node.a, fn), b: mapLeaves(node.b, fn) }
}

/** Rewrites the one leaf named by `paneId`; null when this subtree has no such leaf. */
function mapLeaf(
  node: PaneNode,
  paneId: string,
  fn: (leaf: PaneLeaf) => PaneNode,
): PaneNode | null {
  if (node.kind === 'leaf') return node.paneId === paneId ? fn(node) : null
  const a = mapLeaf(node.a, paneId, fn)
  if (a !== null) return { ...node, a }
  const b = mapLeaf(node.b, paneId, fn)
  return b !== null ? { ...node, b } : null
}

/** Rebuilds the tree only along the path to `nodeId`, so untouched subtrees keep identity. */
function mapSplit(node: PaneNode, nodeId: string, fn: (split: PaneSplit) => PaneSplit): PaneNode {
  if (node.kind === 'leaf') return node
  const a = mapSplit(node.a, nodeId, fn)
  const b = mapSplit(node.b, nodeId, fn)
  if (a === node.a && b === node.b && node.nodeId !== nodeId) return node
  return { ...(node.nodeId === nodeId ? fn(node) : node), a, b }
}

/**
 * Splits `paneId`, putting a fresh blank pane on `edge` of it and focusing that
 * new pane. Returns the layout untouched at {@link MAX_PANES}: the ceiling is a
 * refusal, never a silent close of somebody's pane.
 */
export function splitPane(
  layout: SplitLayout,
  paneId: string,
  edge: PaneEdge,
  newId: IdFactory = randomId,
): SplitLayout {
  if (paneCount(layout) >= MAX_PANES) return layout
  const newPane: PaneLeaf = { kind: 'leaf', paneId: newId('pane'), sessionId: null }
  const leading = edge === 'left' || edge === 'above'
  const root = mapLeaf(layout.root, paneId, (leaf) => ({
    kind: 'split',
    nodeId: newId('split'),
    direction: directionForEdge(edge),
    ratio: 0.5,
    a: leading ? newPane : leaf,
    b: leading ? leaf : newPane,
  }))
  if (root === null) return layout
  return { root, focusedPaneId: newPane.paneId, zoomedPaneId: null }
}

/**
 * Puts a session in a pane. A session is never on screen twice, so one already
 * open elsewhere leaves its old pane **blank** rather than collapsing it: the
 * pane budget is not double-counted and the rest of the layout keeps its shape.
 */
export function assignSession(layout: SplitLayout, paneId: string, sessionId: string): SplitLayout {
  if (findLeaf(layout.root, paneId) === null) return layout
  const current = paneIdForSession(layout, sessionId)
  if (current === paneId) return focusPane(layout, paneId)
  let root = layout.root
  if (current !== null) {
    root = mapLeaf(root, current, (leaf) => ({ ...leaf, sessionId: null })) ?? root
  }
  root = mapLeaf(root, paneId, (leaf) => ({ ...leaf, sessionId })) ?? root
  return { ...layout, root, focusedPaneId: paneId }
}

/** Empties a pane without removing it. */
export function clearPane(layout: SplitLayout, paneId: string): SplitLayout {
  const leaf = findLeaf(layout.root, paneId)
  if (leaf === null || leaf.sessionId === null) return layout
  const root = mapLeaf(layout.root, paneId, (current) => ({ ...current, sessionId: null }))
  return root === null ? layout : { ...layout, root }
}

/**
 * Opens a session in a new pane on `edge` of `paneId` — the shared move behind
 * a sidebar drag-and-drop and the row menu's "Open in split". A session already
 * open is focused where it is instead; a layout at the ceiling is left alone.
 */
export function openSessionInSplit(
  layout: SplitLayout,
  paneId: string,
  sessionId: string,
  edge: PaneEdge,
  newId: IdFactory = randomId,
): SplitLayout {
  const existing = paneIdForSession(layout, sessionId)
  if (existing !== null) return focusPane(layout, existing)
  const split = splitPane(layout, paneId, edge, newId)
  if (split === layout) return layout
  return assignSession(split, split.focusedPaneId, sessionId)
}

/**
 * Puts a session on a pane the user pointed at, rather than the one that had
 * focus: a blank pane simply takes it, and anything else makes room by
 * splitting on the chosen edge. This is the rule behind both the drop zones and
 * the sidebar's "Open in split", so a drop and a menu entry land the same way.
 */
export function placeInPane(
  layout: SplitLayout,
  paneId: string,
  sessionId: string,
  edge: PaneEdge,
  newId: IdFactory = randomId,
): SplitLayout {
  const leaf = findLeaf(layout.root, paneId)
  if (leaf === null) return layout
  return leaf.sessionId === null
    ? assignSession(layout, paneId, sessionId)
    : openSessionInSplit(layout, paneId, sessionId, edge, newId)
}

/**
 * Exchanges what two panes are showing — the tmux swap. The panes keep their
 * places and sizes; only their contents trade. Focus follows `paneId`, which is
 * the pane the gesture landed on.
 */
export function swapPanes(layout: SplitLayout, paneId: string, withPaneId: string): SplitLayout {
  const a = findLeaf(layout.root, paneId)
  const b = findLeaf(layout.root, withPaneId)
  if (a === null || b === null || a.paneId === b.paneId) return layout
  if (a.sessionId === b.sessionId) return layout
  const root = mapLeaves(layout.root, (leaf) => {
    if (leaf.paneId === a.paneId) return { ...leaf, sessionId: b.sessionId }
    if (leaf.paneId === b.paneId) return { ...leaf, sessionId: a.sessionId }
    return leaf
  })
  return { ...layout, root, focusedPaneId: b.paneId, zoomedPaneId: null }
}

/** Removes a leaf and collapses its parent split onto the surviving sibling. */
function removeLeaf(node: PaneNode, paneId: string): { node: PaneNode; survivor: PaneLeaf } | null {
  if (node.kind === 'leaf') return null
  if (node.a.kind === 'leaf' && node.a.paneId === paneId) {
    return { node: node.b, survivor: firstLeaf(node.b) }
  }
  if (node.b.kind === 'leaf' && node.b.paneId === paneId) {
    return { node: node.a, survivor: firstLeaf(node.a) }
  }
  const a = removeLeaf(node.a, paneId)
  if (a !== null) return { node: { ...node, a: a.node }, survivor: a.survivor }
  const b = removeLeaf(node.b, paneId)
  if (b !== null) return { node: { ...node, b: b.node }, survivor: b.survivor }
  return null
}

/**
 * Closes a pane. The neighbour that takes over its space is focused, so
 * closing is reversible by eye: the pane that grew is the one you are in.
 * Closing the last pane empties it instead of leaving the shell with no pane.
 */
export function closePane(layout: SplitLayout, paneId: string): SplitLayout {
  const leaf = findLeaf(layout.root, paneId)
  if (leaf === null) return layout
  if (leaves(layout.root).length <= 1) return clearPane(layout, paneId)
  const removed = removeLeaf(layout.root, paneId)
  if (removed === null) return layout
  return {
    root: removed.node,
    focusedPaneId: removed.survivor.paneId,
    zoomedPaneId: null,
  }
}

/**
 * Moves focus. Zoom follows focus, except when the pane gaining focus is the
 * one that already had it — otherwise clicking the pane you are zoomed into
 * would undo the zoom.
 */
export function focusPane(layout: SplitLayout, paneId: string): SplitLayout {
  if (layout.focusedPaneId === paneId) return layout
  if (findLeaf(layout.root, paneId) === null) return layout
  return { ...layout, focusedPaneId: paneId, zoomedPaneId: null }
}

/** Resizes one split. Not a structural change, so zoom is left alone. */
export function setRatio(layout: SplitLayout, nodeId: string, ratio: number): SplitLayout {
  const root = mapSplit(layout.root, nodeId, (split) => ({ ...split, ratio: clampRatio(ratio) }))
  return root === layout.root ? layout : { ...layout, root }
}

/** Fills the area with the focused pane, or restores the split layout. */
export function toggleZoom(layout: SplitLayout): SplitLayout {
  if (layout.zoomedPaneId !== null) return { ...layout, zoomedPaneId: null }
  if (leaves(layout.root).length <= 1) return layout
  return { ...layout, zoomedPaneId: layout.focusedPaneId }
}

/** Blanks panes whose session is gone (deleted, or never restored). */
export function pruneSessions(layout: SplitLayout, liveIds: ReadonlySet<string>): SplitLayout {
  let changed = false
  const root = mapLeaves(layout.root, (leaf) => {
    if (leaf.sessionId === null || liveIds.has(leaf.sessionId)) return leaf
    changed = true
    return { ...leaf, sessionId: null }
  })
  return changed ? { ...layout, root } : layout
}

export function serializeLayout(layout: SplitLayout): string {
  return JSON.stringify(layout)
}

/** Corrupt, oversized or self-contradicting layouts are rejected, not repaired. */
const MAX_DEPTH = 32

function parseNode(value: unknown, depth: number): PaneNode | null {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return null
  const node = value as Record<string, unknown>
  if (node['kind'] === 'leaf') {
    const paneId = node['paneId']
    const sessionId = node['sessionId']
    if (typeof paneId !== 'string' || paneId === '') return null
    if (sessionId !== null && typeof sessionId !== 'string') return null
    return { kind: 'leaf', paneId, sessionId }
  }
  if (node['kind'] !== 'split') return null
  const { nodeId, direction, ratio } = node
  if (typeof nodeId !== 'string' || nodeId === '') return null
  if (direction !== 'row' && direction !== 'column') return null
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null
  const a = parseNode(node['a'], depth + 1)
  const b = parseNode(node['b'], depth + 1)
  if (a === null || b === null) return null
  return { kind: 'split', nodeId, direction, ratio: clampRatio(ratio), a, b }
}

/**
 * Reads a persisted layout. Anything that would make the tree inconsistent —
 * unparseable JSON, duplicate pane ids, the same session in two panes, more
 * panes than {@link MAX_PANES} — comes back null so the shell starts clean
 * rather than rendering a pane it cannot address.
 */
export function parseLayout(raw: string | null): SplitLayout | null {
  if (raw === null || raw === '') return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  if (decoded === null || typeof decoded !== 'object') return null
  const value = decoded as Record<string, unknown>
  const root = parseNode(value['root'], 0)
  if (root === null) return null
  const panes = leaves(root)
  const anchor = panes[0]
  if (anchor === undefined || panes.length > MAX_PANES) return null
  if (new Set(panes.map((leaf) => leaf.paneId)).size !== panes.length) return null
  const sessionIds = panes.map((leaf) => leaf.sessionId).filter((id): id is string => id !== null)
  if (new Set(sessionIds).size !== sessionIds.length) return null

  const focused = value['focusedPaneId']
  const zoomed = value['zoomedPaneId']
  const focusId =
    typeof focused === 'string' && panes.some((leaf) => leaf.paneId === focused)
      ? focused
      : anchor.paneId
  const zoomId =
    typeof zoomed === 'string' && panes.some((leaf) => leaf.paneId === zoomed) ? zoomed : null
  return { root, focusedPaneId: focusId, zoomedPaneId: zoomId }
}
