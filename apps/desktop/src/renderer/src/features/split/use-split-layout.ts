import {
  activePaneOf,
  assignSession,
  assignTerminal,
  closePane,
  focusPane,
  paneIdForSession,
  placeInPane,
  setRatio,
  splitPane,
  swapPanes,
  toggleZoom,
  type PaneEdge,
  type SplitLayout,
} from './split-layout'
import {
  activeLayoutOf,
  updateActiveLayoutOf,
  withoutSession,
  withoutTerminal,
} from '../spaces/spaces'
import { spaceActions, spaceStoreSnapshot, useSpaces } from '../spaces/use-spaces'

/**
 * The pane actions, seen through the active space. Panes began as a singleton
 * layout; now that a space owns one, this module is the compatibility surface
 * the shell still calls: every read answers for the space on screen, and every
 * write lands on that space's tree. Space-level operations (create, close,
 * switch, rename) live in `features/spaces`.
 */

/** The pane layout of the space currently on screen. */
export function useSplitLayout(): SplitLayout {
  return activeLayoutOf(useSpaces())
}

/** The same layout, for the callers that are not components. */
export function splitLayoutSnapshot(): SplitLayout {
  return activeLayoutOf(spaceStoreSnapshot())
}

/**
 * The layout rewrites, as the shell calls them. Module-level and therefore
 * identity-stable, so they can sit in dependency arrays without churn. Each one
 * first removes the session or terminal from every space — a session lives in
 * exactly one pane across the whole store, not just within one tab — then
 * applies the pane rewrite to the active space.
 */
export const splitLayoutActions = {
  /** Focus follows the pointer, so a pane is active before its content reacts. */
  focus: (paneId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => focusPane(layout, paneId)),
    ),

  /** Splits a pane, leaving the new one blank for a session to be dropped in. */
  split: (paneId: string, edge: PaneEdge): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => splitPane(layout, paneId, edge)),
    ),

  /** Puts a session in a pane — what every session-list click resolves to. */
  assign: (paneId: string, sessionId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(withoutSession(store, sessionId), (layout) =>
        assignSession(layout, paneId, sessionId),
      ),
    ),

  /** Puts a dock terminal in a pane; a terminal already on screen moves there. */
  assignTerminal: (paneId: string, terminalId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(withoutTerminal(store, terminalId), (layout) =>
        assignTerminal(layout, paneId, terminalId),
      ),
    ),

  close: (paneId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => closePane(layout, paneId)),
    ),

  /** A session dropped on a pane, from the sidebar or from another pane. */
  dropSession: (paneId: string, sessionId: string, edge: PaneEdge): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(withoutSession(store, sessionId), (layout) =>
        placeInPane(layout, paneId, sessionId, edge),
      ),
    ),

  /** A pane dropped on another pane: the two trade places, tmux-style. */
  dropPane: (paneId: string, draggedPaneId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => swapPanes(layout, paneId, draggedPaneId)),
    ),

  /**
   * The sidebar row menu's "Open in split": the focused pane splits to take the
   * session, or — when it is blank — simply takes it. A session already on
   * screen is focused where it is rather than moved out from under the user.
   */
  openInSplit: (sessionId: string, edge: PaneEdge): void =>
    spaceActions.update((store) => {
      const open = paneIdForSession(activeLayoutOf(store), sessionId)
      if (open !== null) return updateActiveLayoutOf(store, (layout) => focusPane(layout, open))
      const base = withoutSession(store, sessionId)
      return updateActiveLayoutOf(base, (layout) =>
        placeInPane(layout, activePaneOf(layout), sessionId, edge),
      )
    }),

  /** Moves one split's divider. Called every frame of a separator drag. */
  resize: (nodeId: string, ratio: number): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => setRatio(layout, nodeId, ratio)),
    ),

  /** Fills the area with one pane, or puts the split back. Focuses it first, so
   * the menu entry acts on the pane it was opened on. */
  toggleZoom: (paneId: string): void =>
    spaceActions.update((store) =>
      updateActiveLayoutOf(store, (layout) => toggleZoom(focusPane(layout, paneId))),
    ),

  /** Blanks panes whose session is gone, across every space. */
  prune: (liveIds: ReadonlySet<string>): void => spaceActions.prune(liveIds),

  /** The pane already showing a session, so a click focuses instead of re-opening. */
  paneOf: (sessionId: string): string | null =>
    paneIdForSession(activeLayoutOf(spaceStoreSnapshot()), sessionId),

  /** Test seam: forgets every space so each case starts from a single blank pane. */
  reset: (): void => spaceActions.reset(),
}
