/**
 * Tab state for the docked terminal rail (M24.2). Module-level rather than
 * React state on purpose: the rail unmounts whenever the user closes it or
 * opens another inspector, while the ptys keep running in the main process.
 * Keeping the tab list out here means a reopened rail finds its terminals
 * again instead of orphaning them and spawning a fresh shell.
 */

/** One shell tab in the rail; `id` doubles as the pty session id. */
export interface TerminalTab {
  id: string
  /** Tab label, e.g. "Ari Terminal 2" or "my-app: dev". */
  title: string
  /** Working directory the pty was spawned in. */
  cwd: string
  /** First command written into the shell after spawn (presets, run scripts). */
  command?: string
}

export interface TerminalDockState {
  tabs: readonly TerminalTab[]
  activeId: string | null
}

const EMPTY: TerminalDockState = { tabs: [], activeId: null }

let state: TerminalDockState = EMPTY
const listeners = new Set<() => void>()
let seq = 0

function commit(next: TerminalDockState): void {
  state = next
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore` subscribe half; returns an unsubscribe function. */
export function subscribeTerminalDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * `useSyncExternalStore` snapshot half. The returned object is referentially
 * stable until something mutates the dock, so React can skip re-renders.
 */
export function terminalDockState(): TerminalDockState {
  return state
}

/** First-use title dedupe: "Ari Terminal", "Ari Terminal 2", … */
export function uniqueTabTitle(base: string, tabs: readonly TerminalTab[]): string {
  const taken = new Set(tabs.map((tab) => tab.title))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * Appends a tab and focuses it. The id carries a random suffix so a renderer
 * reload — which restarts the sequence while main-process ptys survive — can
 * never adopt a stranger's shell through the idempotent `terminal.create`.
 */
export function openTerminalTab(tab: Omit<TerminalTab, 'id'>): string {
  const id = `term_${++seq}_${Math.random().toString(36).slice(2, 8)}`
  const titled: TerminalTab = { ...tab, id, title: uniqueTabTitle(tab.title, state.tabs) }
  commit({ tabs: [...state.tabs, titled], activeId: id })
  return id
}

/**
 * Drops a tab. Killing the pty is the caller's job — this module stays free of
 * RPC so it can be unit-tested. Focus falls to the left neighbour, matching
 * how editors settle after a tab close.
 */
export function closeTerminalTab(id: string): void {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const activeId =
    state.activeId === id ? (tabs[Math.max(0, index - 1)]?.id ?? null) : state.activeId
  commit({ tabs, activeId })
}

export function activateTerminalTab(id: string): void {
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) return
  commit({ tabs: state.tabs, activeId: id })
}

/** Test seam: forgets every tab so each case starts from an empty rail. */
export function resetTerminalDock(): void {
  commit(EMPTY)
}
