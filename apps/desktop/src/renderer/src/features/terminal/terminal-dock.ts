/**
 * Tab state for the docked terminal rail (M24.2). Module-level rather than
 * React state on purpose: the rail unmounts whenever the user closes it or
 * opens another inspector, while the ptys keep running in the main process.
 * Keeping the tab list out here means a reopened rail finds its terminals
 * again instead of orphaning them and spawning a fresh shell.
 */

/** A remote tab is permanently owned by one saved host and wire session. */
export type TerminalOwner =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly machineId: string; readonly sessionId: string }

const LOCAL_OWNER: TerminalOwner = Object.freeze({ kind: 'local' })

/** One shell tab. Remote tab IDs are UI identities, never host pty IDs. */
export interface TerminalTab {
  id: string
  /** Tab label, e.g. "Ari Terminal 2" or "my-app: dev". */
  title: string
  /** Working directory the pty was spawned in. */
  cwd: string
  /** First command written into the shell after spawn (presets, run scripts). */
  command?: string
  /** Absent only for legacy/local shells. Never infer remote ownership from cwd. */
  owner?: TerminalOwner
  /** Set once from the authenticated host's confirmed creation result. */
  hostTerminalId?: string
}

export interface TerminalDockState {
  tabs: readonly TerminalTab[]
  activeId: string | null
}

const EMPTY: TerminalDockState = { tabs: [], activeId: null }

/** Where the rail's tabs are remembered between renderer loads. */
export const TERMINAL_DOCK_STORAGE_KEY = 'ari.terminal.dock'

/**
 * Restores the tab list a previous load left behind. The pane layout persists
 * terminal ids too, so without this a reload brings back a pane pointing at a
 * terminal the rail no longer knows: it would show the fallback title, lose the
 * tab's cwd, and — because closing a pane only returns its terminal to the rail
 * — strand the still-running pty with no tab to kill it from.
 *
 * `command` is deliberately not persisted: it is a one-shot written into the
 * shell at spawn, and replaying it on every reload would re-run the user's
 * `pnpm dev` (or worse) behind their back.
 */
function load(): TerminalDockState {
  try {
    const raw = localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY)
    if (raw === null) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).tabs)
    ) {
      return EMPTY
    }
    const raws = (parsed as { tabs: unknown[] }).tabs
    const tabs: TerminalTab[] = []
    for (const entry of raws) {
      if (typeof entry !== 'object' || entry === null) continue
      const { id, title, cwd, owner: rawOwner, hostTerminalId } = entry as Record<string, unknown>
      if (typeof id !== 'string' || typeof title !== 'string' || typeof cwd !== 'string') continue
      const owner = parseOwner(rawOwner)
      // A damaged remote owner/binding must never become a local terminal.
      if (owner === null || (id.startsWith('rterm_') && owner.kind !== 'remote')) continue
      if (hostTerminalId !== undefined && (owner.kind !== 'remote' || !validId(hostTerminalId)))
        continue
      tabs.push({
        id,
        title,
        cwd,
        ...(owner.kind === 'remote' ? { owner } : {}),
        ...(typeof hostTerminalId === 'string' ? { hostTerminalId } : {}),
      })
    }
    if (tabs.length === 0) return EMPTY
    const storedActive = (parsed as { activeId?: unknown }).activeId
    const activeId =
      typeof storedActive === 'string' && tabs.some((tab) => tab.id === storedActive)
        ? storedActive
        : (tabs[0]?.id ?? null)
    return { tabs, activeId }
  } catch {
    // Storage can refuse to be read at all (private mode, disabled cookies).
    return EMPTY
  }
}

let state: TerminalDockState = load()
const listeners = new Set<() => void>()
let seq = 0

function persist(next: TerminalDockState): void {
  try {
    localStorage.setItem(
      TERMINAL_DOCK_STORAGE_KEY,
      JSON.stringify({
        tabs: next.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          cwd: tab.cwd,
          ...(tab.owner?.kind === 'remote' ? { owner: tab.owner } : {}),
          ...(tab.hostTerminalId !== undefined ? { hostTerminalId: tab.hostTerminalId } : {}),
        })),
        activeId: next.activeId,
      }),
    )
  } catch {
    // Best effort: the in-memory dock is already the truth for this run.
  }
}

function commit(next: TerminalDockState): void {
  state = next
  persist(next)
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
export function openTerminalTab(tab: Omit<TerminalTab, 'id' | 'hostTerminalId'>): string {
  const owner = parseOwner(tab.owner)
  if (owner === null) throw new Error('The terminal owner is invalid.')
  const prefix = owner.kind === 'remote' ? 'rterm' : 'term'
  const id = `${prefix}_${++seq}_${Math.random().toString(36).slice(2, 8)}`
  const titled: TerminalTab = {
    ...tab,
    ...(owner.kind === 'remote' ? { owner } : {}),
    id,
    title: uniqueTabTitle(tab.title, state.tabs),
  }
  commit({ tabs: [...state.tabs, titled], activeId: id })
  return id
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function parseOwner(value: unknown): TerminalOwner | null {
  if (value === undefined) return LOCAL_OWNER
  if (typeof value !== 'object' || value === null) return null
  const owner = value as Record<string, unknown>
  if (owner.kind === 'local' && Object.keys(owner).length === 1) return LOCAL_OWNER
  if (
    owner.kind === 'remote' &&
    Object.keys(owner).length === 3 &&
    validId(owner.machineId) &&
    validId(owner.sessionId)
  )
    return Object.freeze({ kind: 'remote', machineId: owner.machineId, sessionId: owner.sessionId })
  return null
}

export function terminalOwnerOf(tab: TerminalTab): TerminalOwner {
  return tab.owner ?? LOCAL_OWNER
}

export function terminalOwnerKey(owner: TerminalOwner): string {
  return owner.kind === 'local' ? 'local' : JSON.stringify([owner.machineId, owner.sessionId])
}

export function terminalTabsForOwner(owner: TerminalOwner): readonly TerminalTab[] {
  const key = terminalOwnerKey(owner)
  return state.tabs.filter((tab) => terminalOwnerKey(terminalOwnerOf(tab)) === key)
}

/** Bind only the verified creation result; later host/session/pty rebinding is refused. */
export function bindRemoteTerminalTab(
  id: string,
  owner: Extract<TerminalOwner, { kind: 'remote' }>,
  hostTerminalId: string,
): void {
  const tab = state.tabs.find((entry) => entry.id === id)
  const expected = parseOwner(owner)
  if (
    !tab ||
    expected?.kind !== 'remote' ||
    tab.owner?.kind !== 'remote' ||
    terminalOwnerKey(tab.owner) !== terminalOwnerKey(expected) ||
    !validId(hostTerminalId) ||
    (tab.hostTerminalId !== undefined && tab.hostTerminalId !== hostTerminalId)
  )
    throw new Error('This terminal belongs to another host, session or shell.')
  if (tab.hostTerminalId === hostTerminalId) return
  commit({
    ...state,
    tabs: state.tabs.map((entry) => (entry.id === id ? { ...entry, hostTerminalId } : entry)),
  })
}

/** Dispose presentation on revoke/removal; original submission receipts live separately. */
export function forgetMachineTerminals(machineId: string): void {
  const tabs = state.tabs.filter(
    (tab) => tab.owner?.kind !== 'remote' || tab.owner.machineId !== machineId,
  )
  if (tabs.length === state.tabs.length) return
  commit({
    tabs,
    activeId: tabs.some((tab) => tab.id === state.activeId)
      ? state.activeId
      : (tabs[0]?.id ?? null),
  })
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
