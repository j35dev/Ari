import type { ReactNode } from 'react'
import { BlankPane, PaneFrame } from './PaneFrame'
import { PaneDropOverlay } from './PaneDropOverlay'
import { SplitSeparator } from './SplitSeparator'
import { usePaneDrop } from './use-pane-drop'
import { usePaneMenu } from './use-pane-menu'
import {
  MAX_PANES,
  activePaneOf,
  findLeaf,
  firstLeaf,
  leaves,
  type PaneEdge,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type SplitLayout,
} from './split-layout'

export interface SplitViewProps {
  layout: SplitLayout
  /** A pane header's title; null while that session has no name yet. */
  titleOf: (sessionId: string) => string | null
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  onSplit: (paneId: string, edge: PaneEdge) => void
  onToggleZoom: (paneId: string) => void
  onResize: (nodeId: string, ratio: number) => void
  onDropSession: (paneId: string, sessionId: string, edge: PaneEdge) => void
  onDropPane: (paneId: string, draggedPaneId: string) => void
  /** One pane's content. Split view owns the chrome; the shell owns this. */
  renderSession: (sessionId: string, paneId: string) => ReactNode
}

/**
 * Renders the pane tree as nested flex containers. A split lays its two
 * children along its axis with the leading child at the split's ratio, with the
 * divider between them; a leaf is a pane. Nesting is what makes every layout the
 * reducer can build expressible — a pane beside a column of two is a row whose
 * second child is a column — without any of the panes knowing where they are.
 */
export function SplitView({
  layout,
  titleOf,
  onFocus,
  onClose,
  onSplit,
  onToggleZoom,
  onResize,
  onDropSession,
  onDropPane,
  renderSession,
}: SplitViewProps) {
  const panes = leaves(layout.root)
  const solo = panes.length === 1
  const canSplit = panes.length < MAX_PANES
  const focusedPaneId = activePaneOf(layout)

  /** A pane's on-screen name — the fallback the frame header uses, so a divider
   * names the two panes the user sees rather than two ids. */
  const nameOf = (leaf: PaneLeaf): string =>
    leaf.sessionId === null ? 'Empty pane' : (titleOf(leaf.sessionId) ?? 'Empty pane')

  const renderLeaf = (leaf: PaneLeaf): ReactNode => {
    const { paneId, sessionId } = leaf
    const blank = sessionId === null
    const content = blank ? <BlankPane /> : renderSession(sessionId, paneId)
    if (solo) {
      // The only pane has no chrome, but it is still what the two gestures act
      // on: the right-click that splits it, and the sidebar drag that is how
      // the second pane comes into being.
      return (
        <SoloDropSurface
          paneId={paneId}
          label={nameOf(leaf)}
          blank={blank}
          canSplit={canSplit}
          onSplit={onSplit}
          onDropSession={onDropSession}
          onDropPane={onDropPane}
        >
          {content}
        </SoloDropSurface>
      )
    }
    return (
      <PaneFrame
        paneId={paneId}
        title={blank ? null : titleOf(sessionId)}
        focused={paneId === focusedPaneId}
        blank={blank}
        zoomed={layout.zoomedPaneId !== null}
        canSplit={canSplit}
        onFocus={onFocus}
        onClose={onClose}
        onSplit={onSplit}
        onToggleZoom={onToggleZoom}
        onDropSession={onDropSession}
        onDropPane={onDropPane}
      >
        {content}
      </PaneFrame>
    )
  }

  const renderNode = (node: PaneNode): ReactNode =>
    node.kind === 'leaf' ? (
      renderLeaf(node)
    ) : (
      <SplitNode node={node} renderNode={renderNode} nameOf={nameOf} onResize={onResize} />
    )

  // Zoom fills the area with one pane. It keeps its frame, which is how a zoom
  // reads as a zoom rather than as a layout that lost its other panes.
  const zoomed = layout.zoomedPaneId === null ? null : findLeaf(layout.root, layout.zoomedPaneId)
  return <>{zoomed === null ? renderNode(layout.root) : renderLeaf(zoomed)}</>
}

/**
 * The lone pane's surface. It carries no chrome — a single pane looks exactly
 * as it always has — but it is still the pane, so it takes both the drop and
 * the right-click menu; the menu's close and zoom entries are left out, since
 * an only pane has nothing to close beside and already fills the area.
 */
function SoloDropSurface({
  paneId,
  label,
  blank,
  canSplit,
  onSplit,
  onDropSession,
  onDropPane,
  children,
}: {
  paneId: string
  label: string
  blank: boolean
  canSplit: boolean
  onSplit: (paneId: string, edge: PaneEdge) => void
  onDropSession: (paneId: string, sessionId: string, edge: PaneEdge) => void
  onDropPane: (paneId: string, draggedPaneId: string) => void
  children: ReactNode
}) {
  const menu = usePaneMenu({ paneId, label, canSplit, onSplit })
  const drop = usePaneDrop({ paneId, blank, canSplit, onDropSession, onDropPane })
  return (
    <div
      {...menu.menuProps}
      {...drop.dropProps}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      {children}
      <PaneDropOverlay target={drop.target} />
      {menu.element}
    </div>
  )
}

function SplitNode({
  node,
  renderNode,
  nameOf,
  onResize,
}: {
  node: PaneSplit
  renderNode: (node: PaneNode) => ReactNode
  nameOf: (leaf: PaneLeaf) => string
  onResize: (nodeId: string, ratio: number) => void
}) {
  const row = node.direction === 'row'
  return (
    <div className={`flex h-full min-h-0 w-full min-w-0 ${row ? 'flex-row' : 'flex-col'}`}>
      {/* The leading child carries the ratio and gives up the separator's few
          pixels; the trailing child takes whatever is left, so the two always
          fill the container exactly. */}
      <div className="flex min-h-0 min-w-0" style={{ flex: `0 1 ${String(node.ratio * 100)}%` }}>
        {renderNode(node.a)}
      </div>
      <SplitSeparator
        nodeId={node.nodeId}
        label={`Resize ${nameOf(firstLeaf(node.a))} and ${nameOf(firstLeaf(node.b))}`}
        direction={node.direction}
        ratio={node.ratio}
        onResize={onResize}
      />
      <div className="flex min-h-0 min-w-0 flex-1">{renderNode(node.b)}</div>
    </div>
  )
}
