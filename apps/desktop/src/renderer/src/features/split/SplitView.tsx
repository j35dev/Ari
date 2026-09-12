import type { ReactNode } from 'react'
import { BlankPane, PaneFrame } from './PaneFrame'
import {
  findLeaf,
  leaves,
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
  /** One pane's content. Split view owns the chrome; the shell owns this. */
  renderSession: (sessionId: string, paneId: string) => ReactNode
}

/**
 * Renders the pane tree as nested flex containers. A split lays its two
 * children along its axis with the leading child at the split's ratio; a leaf
 * is a pane. Nesting is what makes every layout the reducer can build
 * expressible — a pane beside a column of two is a row whose second child is a
 * column — without any of the panes knowing where they are.
 */
export function SplitView({ layout, titleOf, onFocus, onClose, renderSession }: SplitViewProps) {
  const solo = leaves(layout.root).length === 1
  const focusedPaneId = layout.zoomedPaneId ?? layout.focusedPaneId

  const renderLeaf = (leaf: PaneLeaf): ReactNode => {
    const content =
      leaf.sessionId === null ? <BlankPane /> : renderSession(leaf.sessionId, leaf.paneId)
    if (solo) return content
    return (
      <PaneFrame
        paneId={leaf.paneId}
        title={leaf.sessionId === null ? null : titleOf(leaf.sessionId)}
        focused={leaf.paneId === focusedPaneId}
        onFocus={onFocus}
        onClose={onClose}
      >
        {content}
      </PaneFrame>
    )
  }

  const renderNode = (node: PaneNode): ReactNode =>
    node.kind === 'leaf' ? renderLeaf(node) : <SplitNode node={node} renderNode={renderNode} />

  // Zoom fills the area with one pane. It keeps its frame, which is how a zoom
  // reads as a zoom rather than as a layout that lost its other panes.
  const zoomed = layout.zoomedPaneId === null ? null : findLeaf(layout.root, layout.zoomedPaneId)
  return <>{zoomed === null ? renderNode(layout.root) : renderLeaf(zoomed)}</>
}

function SplitNode({
  node,
  renderNode,
}: {
  node: PaneSplit
  renderNode: (node: PaneNode) => ReactNode
}) {
  const row = node.direction === 'row'
  return (
    <div className={`flex h-full min-h-0 w-full min-w-0 ${row ? 'flex-row' : 'flex-col'}`}>
      {/* The leading child carries the ratio and may give up a few pixels to a
          separator; the trailing child takes whatever is left, so the two
          always fill the container exactly. */}
      <div className="flex min-h-0 min-w-0" style={{ flex: `0 1 ${String(node.ratio * 100)}%` }}>
        {renderNode(node.a)}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">{renderNode(node.b)}</div>
    </div>
  )
}
