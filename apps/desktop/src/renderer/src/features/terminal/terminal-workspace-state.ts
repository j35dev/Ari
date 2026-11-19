import { useSyncExternalStore } from 'react'
import {
  initialLayout,
  parseLayout,
  serializeLayout,
  leaves,
  assignTerminal,
  clearPane,
  closePane,
  focusPane,
  setRatio,
  splitPane,
  swapPanes,
  toggleZoom,
  activePaneOf,
  type SplitLayout,
  type PaneEdge,
  type PaneLeaf,
  type PaneNode,
} from '../split/split-layout'

export type WorkspaceView = 'sessions' | 'terminals'
export type TerminalDeskPreset = 'desk' | 'agents' | 'workbench'
export interface TerminalTask {
  id: string
  title: string
  projectId: string
  cwd: string
  layout: SplitLayout
  closed: boolean
  createdAt: number
}
export interface TerminalWorkspaceState {
  view: WorkspaceView
  tasks: readonly TerminalTask[]
  activeTaskId: string | null
  selectedProjectId: string | null
  preset: TerminalDeskPreset
  panel: 'files' | 'changes' | null
  reviewTab: 'changes' | 'requests'
  overlay: 'preferences' | 'usage' | null
  launchRequest: number
  launchInNewSpace: boolean
}
export const TERMINAL_WORKSPACE_KEY = 'ari.terminal.workspace.v1'
export const MAX_TERMINAL_TASKS = 24
const EMPTY: TerminalWorkspaceState = {
  view: 'sessions',
  tasks: [],
  activeTaskId: null,
  selectedProjectId: null,
  preset: 'desk',
  panel: null,
  reviewTab: 'changes',
  overlay: null,
  launchRequest: 0,
  launchInNewSpace: false,
}
const id = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`
const listeners = new Set<() => void>()

export function parseTerminalWorkspace(raw: string | null): TerminalWorkspaceState | null {
  try {
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      value.version !== 1 ||
      !Array.isArray(value.tasks) ||
      value.tasks.length > MAX_TERMINAL_TASKS
    )
      return null
    const tasks: TerminalTask[] = []
    const terminals = new Set<string>()
    for (const entry of value.tasks) {
      if (!entry || typeof entry !== 'object') return null
      const task = entry as Record<string, unknown>
      if (
        typeof task.id !== 'string' ||
        !task.id ||
        typeof task.title !== 'string' ||
        !task.title ||
        typeof task.projectId !== 'string' ||
        !task.projectId ||
        typeof task.cwd !== 'string' ||
        !task.cwd ||
        typeof task.layout !== 'string' ||
        typeof task.closed !== 'boolean' ||
        typeof task.createdAt !== 'number' ||
        !Number.isFinite(task.createdAt)
      )
        return null
      const layout = parseLayout(task.layout)
      if (!layout || leaves(layout.root).some((pane) => pane.sessionId !== null)) return null
      for (const pane of leaves(layout.root))
        if (pane.terminalId) {
          if (terminals.has(pane.terminalId) || pane.terminalId.startsWith('rterm_')) return null
          terminals.add(pane.terminalId)
        }
      tasks.push({
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        cwd: task.cwd,
        layout,
        closed: task.closed,
        createdAt: task.createdAt,
      })
    }
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return null
    const active = tasks.find((task) => task.id === value.activeTaskId && !task.closed)
    return {
      view: value.view === 'terminals' ? 'terminals' : 'sessions',
      tasks,
      activeTaskId: active?.id ?? tasks.find((task) => !task.closed)?.id ?? null,
      selectedProjectId:
        active?.projectId ??
        (typeof value.selectedProjectId === 'string' ? value.selectedProjectId : null),
      preset: value.preset === 'agents' || value.preset === 'workbench' ? value.preset : 'desk',
      panel: value.panel === 'files' || value.panel === 'changes' ? value.panel : null,
      reviewTab: value.reviewTab === 'requests' ? 'requests' : 'changes',
      overlay: null,
      launchRequest: 0,
      launchInNewSpace: false,
    }
  } catch {
    return null
  }
}

export function serializeTerminalWorkspace(value: TerminalWorkspaceState): string {
  const {
    overlay: _overlay,
    launchRequest: _request,
    launchInNewSpace: _newSpace,
    ...saved
  } = value
  return JSON.stringify({
    ...saved,
    version: 1,
    tasks: value.tasks.map((task) => ({ ...task, layout: serializeLayout(task.layout) })),
  })
}
function load(): TerminalWorkspaceState {
  try {
    return parseTerminalWorkspace(localStorage.getItem(TERMINAL_WORKSPACE_KEY)) ?? EMPTY
  } catch {
    return EMPTY
  }
}
let state = load()
let pendingSave: ReturnType<typeof setTimeout> | null = null
export const terminalWorkspaceSnapshot = (): TerminalWorkspaceState => state
export function subscribeTerminalWorkspace(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useTerminalWorkspace(): TerminalWorkspaceState {
  return useSyncExternalStore(subscribeTerminalWorkspace, terminalWorkspaceSnapshot)
}
function save(): void {
  if (pendingSave !== null) clearTimeout(pendingSave)
  pendingSave = null
  try {
    localStorage.setItem(TERMINAL_WORKSPACE_KEY, serializeTerminalWorkspace(state))
  } catch {
    /* memory remains authoritative */
  }
}
function commit(next: TerminalWorkspaceState, deferSave = false): void {
  if (next === state) return
  state = next
  if (deferSave) {
    if (pendingSave !== null) clearTimeout(pendingSave)
    pendingSave = setTimeout(save, 200)
  } else save()
  for (const listener of listeners) listener()
}
function rewrite(
  taskId: string,
  change: (layout: SplitLayout) => SplitLayout,
  deferSave = false,
): void {
  let changed = false
  const tasks = state.tasks.map((task) => {
    if (task.id !== taskId) return task
    const layout = change(task.layout)
    if (layout === task.layout) return task
    changed = true
    return { ...task, layout }
  })
  if (changed) commit({ ...state, tasks }, deferSave)
}

/** Rebuild geometry with stable pane identities; changing arrangement never launches a process. */
export function arrangeTerminalPanes(
  layout: SplitLayout,
  arrangement: 'columns' | 'grid',
): SplitLayout {
  const panes = leaves(layout.root)
  const build = (items: PaneLeaf[], depth = 0): PaneNode => {
    if (items.length === 1) return items[0]!
    const middle = Math.ceil(items.length / 2)
    return {
      kind: 'split',
      nodeId: id('twsplit'),
      direction: arrangement === 'columns' || depth % 2 === 0 ? 'row' : 'column',
      ratio: middle / items.length,
      a: build(items.slice(0, middle), depth + 1),
      b: build(items.slice(middle), depth + 1),
    }
  }
  return { ...layout, root: build(panes), zoomedPaneId: null }
}

export const terminalWorkspaceActions = {
  setView(view: WorkspaceView, projectId?: string | null): void {
    if (view === state.view && !projectId) return
    const task = projectId
      ? (state.tasks.find(
          (task) => task.id === state.activeTaskId && task.projectId === projectId && !task.closed,
        ) ?? state.tasks.find((task) => task.projectId === projectId && !task.closed))
      : undefined
    if (
      view === state.view &&
      projectId === state.selectedProjectId &&
      (task?.id ?? null) === state.activeTaskId
    )
      return
    commit({
      ...state,
      view,
      ...(projectId ? { selectedProjectId: projectId, activeTaskId: task?.id ?? null } : {}),
    })
  },
  selectProject(projectId: string): void {
    const task = state.tasks.find((task) => !task.closed && task.projectId === projectId)
    commit({ ...state, selectedProjectId: projectId, activeTaskId: task?.id ?? null })
  },
  createTask(projectId: string, cwd: string, title: string): TerminalTask {
    if (state.tasks.length >= MAX_TERMINAL_TASKS)
      throw new Error('Stop an unused space before opening another.')
    const task: TerminalTask = {
      id: id('twtask'),
      title: title.trim().slice(0, 100) || 'Terminal space',
      projectId,
      cwd,
      layout: initialLayout((kind) => id(`tw${kind}`)),
      closed: false,
      createdAt: Date.now(),
    }
    commit({
      ...state,
      tasks: [...state.tasks, task],
      activeTaskId: task.id,
      selectedProjectId: projectId,
    })
    return task
  },
  selectTask(taskId: string): void {
    const task = state.tasks.find((task) => task.id === taskId)
    if (!task) return
    commit({
      ...state,
      activeTaskId: taskId,
      selectedProjectId: task.projectId,
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, closed: false } : task)),
    })
  },
  renameTask(taskId: string, title: string): void {
    const name = title.trim().slice(0, 100)
    if (name)
      commit({
        ...state,
        tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, title: name } : task)),
      })
  },
  closeTask(taskId: string): void {
    const tasks = state.tasks.map((task) => (task.id === taskId ? { ...task, closed: true } : task))
    commit({
      ...state,
      tasks,
      activeTaskId:
        state.activeTaskId === taskId
          ? (tasks.find((task) => !task.closed && task.projectId === state.selectedProjectId)?.id ??
            null)
          : state.activeTaskId,
    })
  },
  forgetTask(taskId: string): void {
    commit({
      ...state,
      tasks: state.tasks.filter((task) => task.id !== taskId),
      activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
    })
  },
  attach(taskId: string, terminalId: string, paneId?: string, edge?: PaneEdge): void {
    if (
      state.tasks.some(
        (task) =>
          task.id !== taskId &&
          leaves(task.layout.root).some((pane) => pane.terminalId === terminalId),
      )
    )
      return
    rewrite(taskId, (layout) => {
      const target = paneId ?? activePaneOf(layout)
      if (!leaves(layout.root).some((pane) => pane.paneId === target)) return layout
      if (!edge) return assignTerminal(layout, target, terminalId)
      const next = splitPane(layout, target, edge)
      return next === layout ? layout : assignTerminal(next, activePaneOf(next), terminalId)
    })
  },
  detach(taskId: string, paneId: string): void {
    rewrite(taskId, (layout) => closePane(layout, paneId))
  },
  removeTerminal(terminalId: string): void {
    commit({
      ...state,
      tasks: state.tasks.map((task) => {
        let layout = task.layout
        for (const pane of leaves(layout.root))
          if (pane.terminalId === terminalId) layout = clearPane(layout, pane.paneId)
        return layout === task.layout ? task : { ...task, layout }
      }),
    })
  },
  focus(taskId: string, paneId: string): void {
    rewrite(taskId, (layout) => focusPane(layout, paneId))
  },
  resize(taskId: string, nodeId: string, ratio: number): void {
    rewrite(taskId, (layout) => setRatio(layout, nodeId, ratio), true)
  },
  zoom(taskId: string, paneId: string): void {
    rewrite(taskId, (layout) => toggleZoom(focusPane(layout, paneId)))
  },
  swap(taskId: string, first: string, second: string): void {
    rewrite(taskId, (layout) => swapPanes(layout, first, second))
  },
  arrange(taskId: string, arrangement: 'columns' | 'grid'): void {
    rewrite(taskId, (layout) => arrangeTerminalPanes(layout, arrangement))
  },
  preset(preset: TerminalDeskPreset): void {
    commit({ ...state, preset, panel: preset === 'workbench' ? (state.panel ?? 'files') : null })
  },
  panel(panel: 'files' | 'changes' | null, reviewTab: 'changes' | 'requests' = 'changes'): void {
    commit({ ...state, panel, reviewTab })
  },
  overlay(overlay: 'preferences' | 'usage' | null): void {
    commit({ ...state, overlay })
  },
  requestLaunch(): void {
    commit({
      ...state,
      view: 'terminals',
      launchRequest: state.launchRequest + 1,
      launchInNewSpace: false,
    })
  },
  requestNewSpace(): void {
    commit({
      ...state,
      view: 'terminals',
      launchRequest: state.launchRequest + 1,
      launchInNewSpace: true,
    })
  },
  reset(): void {
    commit(EMPTY)
  },
}
