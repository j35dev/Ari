import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Archive,
  ArrowRight,
  ChevronDown,
  Columns2,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  Plus,
  Search,
  Settings2,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { Project } from '@ari/contracts/project'
import type { TerminalProfile, TerminalProfiles } from '@ari/contracts/rpc'
import { Dialog } from '@ari/ui/dialog'
import { ContextMenu, anchorBelow, type MenuAnchor } from '../../shell/ContextMenu'
import { rpc } from '../../lib/rpc'
import { ProviderLogo } from '../composer/provider-logo'
import { ChangesView } from '../changes/ChangesView'
import { FileExplorer } from '../files/FileExplorer'
import { UsagePage } from '../usage/UsagePage'
import { SessionClientProvider } from '../session/session-client'
import { activePaneOf, findLeaf, leaves, MAX_PANES, type PaneEdge } from '../split/split-layout'
import { focusNeighbour } from '../split/split-geometry'
import { nextSpaceName } from '../spaces/spaces'
import {
  closeTerminalTab,
  openTerminalTab,
  subscribeTerminalDock,
  terminalDockState,
  type TerminalTab,
} from './terminal-dock'
import { destroyTerminalRuntime, findTerminalRuntime, useTerminalStatus } from './terminal-runtime'
import { setTerminalPreferences, useTerminalPreferences } from './terminal-preferences'
import { TerminalWorkspaceGrid, displayTerminalPath } from './TerminalWorkspaceGrid'
import { TerminalWorkspaceSettings } from './TerminalWorkspaceSettings'
import { TerminalLayoutPicker } from './TerminalLayoutPicker'
import { TerminalProjectPicker } from './TerminalProjectPicker'
import {
  terminalWorkspaceActions as actions,
  terminalWorkspaceSnapshot,
  useTerminalWorkspace,
  type TerminalTask,
  MAX_TERMINAL_TASKS,
} from './terminal-workspace-state'

const DEFAULT_PROFILES: TerminalProfiles = {
  platform: 'win32',
  shell: 'powershell.exe',
  profiles: [
    { id: 'shell', label: 'Shell', available: true },
    { id: 'claude', label: 'Claude Code', available: false },
    { id: 'codex', label: 'Codex', available: false },
  ],
}
const LOCAL_SCOPE = { kind: 'local', sessionId: '' } as const
interface LauncherTarget {
  taskId?: string
  paneId?: string
  edge?: PaneEdge
  newSpace?: boolean
}

export function TerminalWorkspace({
  projects,
  visible,
  onAddProject,
  onSettings,
  onPalette,
}: {
  projects: readonly Project[]
  visible: boolean
  onAddProject: () => void
  onSettings: () => void
  onPalette: () => void
}) {
  const workspace = useTerminalWorkspace()
  const prefs = useTerminalPreferences()
  const dock = useSyncExternalStore(subscribeTerminalDock, terminalDockState)
  const [profiles, setProfiles] = useState(DEFAULT_PROFILES)
  const [profilesError, setProfilesError] = useState<string | null>(null)
  const [launchMenu, setLaunchMenu] = useState<MenuAnchor | null>(null)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [searchTarget, setSearchTarget] = useState<string | null>(null)
  const [projectSearch, setProjectSearch] = useState('')
  const [renamingTask, setRenamingTask] = useState<string | null>(null)
  const [taskName, setTaskName] = useState('')
  const [prefix, setPrefix] = useState(false)
  const prefixRef = useRef(false)
  const lastLaunchRequest = useRef(0)
  const autoOpenedProjects = useRef(new Set<string>())
  const tabStripRef = useRef<HTMLDivElement>(null)
  const targetProject =
    projects.find((project) => project.id === workspace.selectedProjectId) ?? projects[0] ?? null
  const activeTask =
    workspace.tasks.find((task) => task.id === workspace.activeTaskId && !task.closed) ?? null
  const activeTab = dock.tabs.find(
    (tab) =>
      tab.id ===
      (activeTask && findLeaf(activeTask.layout.root, activePaneOf(activeTask.layout))?.terminalId),
  )
  const activeStatus = useTerminalStatus(activeTab?.id ?? '')
  const openTasks = workspace.tasks.filter(
    (task) => !task.closed && task.projectId === targetProject?.id,
  )
  const taskTabs = dock.tabs.filter((tab) => tab.workspaceTaskId)
  const parkedTasks = workspace.tasks.filter((task) => task.closed)
  const sidebar = workspace.preset !== 'desk'
  const activePanes = activeTask ? leaves(activeTask.layout.root) : []
  const canAddTerminal =
    activePanes.length < MAX_PANES || activePanes.some((pane) => !pane.terminalId)

  useEffect(() => {
    if (visible)
      tabStripRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [visible, activeTask?.id])

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('terminal.profiles', {})
      .then((value) => {
        if (!cancelled && value) {
          setProfiles(value)
          setProfilesError(null)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setProfilesError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (
      visible &&
      !projects.some((project) => project.id === workspace.selectedProjectId) &&
      projects[0]
    )
      actions.selectProject(projects[0].id)
  }, [visible, workspace.selectedProjectId, projects])

  const launchTerminal = useCallback(
    async (
      task: TerminalTask,
      kind: TerminalProfile,
      customCommand: string,
      paneId?: string,
      edge?: PaneEdge,
    ): Promise<void> => {
      const label =
        kind === 'custom'
          ? (customCommand.trim().split(/\s+/)[0] ?? 'Command')
          : (profiles.profiles.find((item) => item.id === kind)?.label ?? kind)
      const id = openTerminalTab({
        title: label,
        cwd: task.cwd,
        workspaceTaskId: task.id,
        profile: kind,
        ...(kind === 'custom' ? { launchCommand: customCommand } : {}),
      })
      setPending((old) => new Set([...old, id]))
      actions.attach(task.id, id, paneId, edge)
      try {
        await rpc.invoke('terminal.launch', {
          id,
          cwd: task.cwd,
          profile: kind,
          ...(kind === 'custom' ? { command: customCommand } : {}),
        })
        await findTerminalRuntime(id)?.refreshInfo()
      } catch (error: unknown) {
        setErrors((old) => ({
          ...old,
          [id]: error instanceof Error ? error.message : String(error),
        }))
      } finally {
        setPending((old) => {
          const next = new Set(old)
          next.delete(id)
          return next
        })
      }
    },
    [profiles],
  )

  const openTerminal = useCallback(
    (kind: Exclude<TerminalProfile, 'custom'> = 'shell', target: LauncherTarget = {}): void => {
      const snapshot = terminalWorkspaceSnapshot()
      const project =
        projects.find((project) => project.id === snapshot.selectedProjectId) ?? projects[0]
      if (!project) return
      const existing = target.taskId
        ? snapshot.tasks.find((task) => task.id === target.taskId && !task.closed)
        : target.newSpace
          ? undefined
          : snapshot.tasks.find(
              (task) =>
                task.id === snapshot.activeTaskId && task.projectId === project.id && !task.closed,
            )
      if (target.taskId && !existing) return
      const blank =
        !target.paneId && existing
          ? leaves(existing.layout.root).find((pane) => !pane.terminalId)
          : undefined
      const paneId =
        target.paneId ?? blank?.paneId ?? (existing ? activePaneOf(existing.layout) : undefined)
      const pane = existing && paneId ? findLeaf(existing.layout.root, paneId) : null
      const edge = target.edge ?? (pane?.terminalId ? 'right' : undefined)
      if (existing && edge && leaves(existing.layout.root).length >= MAX_PANES) return
      try {
        const name = nextSpaceName(
          snapshot.tasks
            .filter((task) => task.projectId === project.id)
            .map((task) => ({ name: task.title })),
        )
        const task = existing ?? actions.createTask(project.id, project.path, name)
        setLaunchError(null)
        setLaunchMenu(null)
        void launchTerminal(task, kind, '', paneId, edge)
      } catch (error: unknown) {
        setLaunchError(error instanceof Error ? error.message : String(error))
      }
    },
    [projects, profiles, launchTerminal],
  )
  const newSpace = useCallback(() => openTerminal('shell', { newSpace: true }), [openTerminal])

  const split = useCallback(
    (task: TerminalTask, paneId: string, edge?: PaneEdge): void => {
      const pane = findLeaf(task.layout.root, paneId)
      openTerminal('shell', { taskId: task.id, paneId, edge: pane?.terminalId ? edge : undefined })
    },
    [openTerminal],
  )

  useEffect(() => {
    if (workspace.launchRequest !== lastLaunchRequest.current) {
      lastLaunchRequest.current = workspace.launchRequest
      openTerminal('shell', workspace.launchInNewSpace ? { newSpace: true } : {})
    }
  }, [workspace.launchRequest, workspace.launchInNewSpace, openTerminal])

  // First entry into a project lands in a shell. Parking/closing an existing
  // tab stays deliberate: it must not trigger an unwanted replacement shell.
  useEffect(() => {
    if (!visible || !targetProject || autoOpenedProjects.current.has(targetProject.id)) return
    if (terminalWorkspaceSnapshot().tasks.some((task) => task.projectId === targetProject.id))
      return
    autoOpenedProjects.current.add(targetProject.id)
    openTerminal()
  }, [visible, targetProject, openTerminal])

  const stop = useCallback(async (task: TerminalTask, tab: TerminalTab): Promise<void> => {
    try {
      await rpc.invoke('terminal.kill', { id: tab.id })
      destroyTerminalRuntime(tab.id)
      actions.removeTerminal(tab.id)
      closeTerminalTab(tab.id)
      setErrors((old) => {
        const next = { ...old }
        delete next[tab.id]
        return next
      })
      if (!terminalDockState().tabs.some((item) => item.workspaceTaskId === task.id))
        actions.forgetTask(task.id)
    } catch (error: unknown) {
      setErrors((old) => ({
        ...old,
        [tab.id]: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [])
  const restart = useCallback(
    async (task: TerminalTask, tab: TerminalTab, paneId: string): Promise<void> => {
      try {
        await rpc.invoke('terminal.kill', { id: tab.id })
        destroyTerminalRuntime(tab.id)
        actions.removeTerminal(tab.id)
        closeTerminalTab(tab.id)
        setErrors((old) => {
          const next = { ...old }
          delete next[tab.id]
          return next
        })
        await launchTerminal(task, tab.profile ?? 'shell', tab.launchCommand ?? '', paneId)
      } catch (error: unknown) {
        setErrors((old) => ({
          ...old,
          [tab.id]: error instanceof Error ? error.message : String(error),
        }))
      }
    },
    [launchTerminal],
  )

  useEffect(() => {
    if (!visible) return
    const togglePrefix = (value: boolean): void => {
      prefixRef.current = value
      setPrefix(value)
    }
    const key = (event: KeyboardEvent): void => {
      if (
        event.isComposing ||
        launchMenu ||
        workspace.overlay !== null ||
        renamingTask ||
        document.querySelector('[role="dialog"]')
      )
        return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input,textarea,select,[contenteditable="true"],[role="menu"],[role="listbox"]',
        ) &&
        !event.target.closest('.xterm')
      )
        return
      const state = terminalWorkspaceSnapshot()
      const task = state.tasks.find((task) => task.id === state.activeTaskId && !task.closed)
      const pane = task && findLeaf(task.layout.root, activePaneOf(task.layout))
      const tab =
        pane?.terminalId && terminalDockState().tabs.find((tab) => tab.id === pane.terminalId)
      const mod = event.ctrlKey || event.metaKey
      const k = event.key.toLowerCase()
      const cycle = (delta: number): void => {
        const tasks = state.tasks.filter(
          (task) => !task.closed && task.projectId === state.selectedProjectId,
        )
        if (!tasks.length) return
        const index = tasks.findIndex((task) => task.id === state.activeTaskId)
        actions.selectTask(tasks[(index + delta + tasks.length) % tasks.length]!.id)
      }
      const focus = (edge: PaneEdge): void => {
        if (!task) return
        const next = focusNeighbour(task.layout, activePaneOf(task.layout), edge)
        if (next) actions.focus(task.id, next)
      }
      let action: (() => void) | undefined
      if (prefs.prefixKeys && event.ctrlKey && !event.altKey && !event.shiftKey && k === 'b') {
        if (prefixRef.current) {
          if (tab) findTerminalRuntime(tab.id)?.terminal.input('\x02', true)
          togglePrefix(false)
        } else togglePrefix(true)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (prefixRef.current) {
        const prefixActions: Record<string, () => void> = {
          c: newSpace,
          n: () => cycle(1),
          p: () => cycle(-1),
          '%': () => {
            if (task && pane) split(task, pane.paneId, 'right')
          },
          '"': () => {
            if (task && pane) split(task, pane.paneId, 'below')
          },
          x: () => {
            if (task && pane) actions.detach(task.id, pane.paneId)
          },
          z: () => {
            if (task && pane) actions.zoom(task.id, pane.paneId)
          },
          h: () => focus('left'),
          j: () => focus('below'),
          k: () => focus('above'),
          l: () => focus('right'),
          Escape: () => undefined,
        }
        action = prefixActions[event.key]
        togglePrefix(false)
      } else if (mod && event.shiftKey && !event.altKey) {
        const commands: Record<string, () => void> = {
          t: () => openTerminal(),
          n: newSpace,
          o: () => {
            if (task && pane) split(task, pane.paneId, 'right')
          },
          e: () => {
            if (task && pane) split(task, pane.paneId, 'below')
          },
          z: () => {
            if (task && pane) actions.zoom(task.id, pane.paneId)
          },
          x: () => {
            if (task && pane) actions.detach(task.id, pane.paneId)
          },
          w: () => {
            if (task) actions.closeTask(task.id)
          },
          f: () => {
            if (tab) setSearchTarget(tab.id)
          },
          p: onPalette,
          arrowleft: () => focus('left'),
          arrowright: () => focus('right'),
          arrowup: () => focus('above'),
          arrowdown: () => focus('below'),
        }
        action = commands[k]
      } else if (event.ctrlKey && event.key === 'Tab') action = () => cycle(event.shiftKey ? -1 : 1)
      else if (mod && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        action = () => {
          const task = state.tasks.filter(
            (task) => !task.closed && task.projectId === state.selectedProjectId,
          )[Number(event.key) - 1]
          if (task) actions.selectTask(task.id)
        }
      }
      if (action) {
        event.preventDefault()
        event.stopPropagation()
        action()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      prefixRef.current = false
    }
  }, [
    visible,
    launchMenu,
    workspace.overlay,
    prefs.prefixKeys,
    renamingTask,
    openTerminal,
    newSpace,
    split,
    onPalette,
  ])

  const renderedProjectList = projects.filter((project) =>
    `${project.name} ${project.path}`.toLowerCase().includes(projectSearch.toLowerCase()),
  )
  const scopedTask =
    activeTask ?? (targetProject ? { projectId: targetProject.id, cwd: targetProject.path } : null)
  return (
    <SessionClientProvider scope={LOCAL_SCOPE}>
      <div
        className="ari-terminal-workspace"
        data-ari-part="terminal-workspace"
        data-preset={workspace.preset}
        data-pane-style={prefs.paneStyle}
        hidden={!visible}
        inert={!visible}
      >
        {sidebar && (
          <aside className="ari-terminal-sidebar" data-ari-part="terminal-sidebar">
            <div className="ari-terminal-sidebar-label">
              <span>Projects</span>
              <button
                type="button"
                className="ari-terminal-pane-button"
                aria-label="Add terminal project"
                onClick={onAddProject}
              >
                <Plus size={14} aria-hidden />
              </button>
            </div>
            <label className="ari-terminal-project-search">
              <Search size={13} aria-hidden />
              <input
                aria-label="Filter terminal projects"
                placeholder="Find a project"
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
              />
            </label>
            <div className="ari-terminal-project-list">
              {renderedProjectList.map((project) => (
                <div key={project.id}>
                  <button
                    type="button"
                    className="ari-terminal-project"
                    data-selected={targetProject?.id === project.id}
                    title={project.path}
                    onClick={() => actions.selectProject(project.id)}
                  >
                    <Folder size={14} strokeWidth={1.5} aria-hidden />
                    <span>{project.name}</span>
                    <span>
                      {workspace.tasks.filter(
                        (task) => task.projectId === project.id && !task.closed,
                      ).length || ''}
                    </span>
                  </button>
                  {targetProject?.id === project.id &&
                    workspace.tasks
                      .filter((task) => task.projectId === project.id && !task.closed)
                      .map((task) => (
                        <button
                          type="button"
                          key={task.id}
                          className="ari-terminal-task-row"
                          data-selected={task.id === workspace.activeTaskId}
                          onClick={() => actions.selectTask(task.id)}
                        >
                          <TerminalSquare size={12} aria-hidden />
                          <span>{task.title}</span>
                        </button>
                      ))}
                </div>
              ))}
              {!projects.length && (
                <button type="button" className="ari-terminal-text-button" onClick={onAddProject}>
                  <FolderOpen size={14} aria-hidden />
                  Add a project
                </button>
              )}
            </div>
            <div className="ari-terminal-sidebar-bottom">
              {!!parkedTasks.length && (
                <details>
                  <summary>
                    <Archive size={13} aria-hidden />
                    Parked spaces<span>{parkedTasks.length}</span>
                  </summary>
                  {parkedTasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className="ari-terminal-task-row"
                      onClick={() => actions.selectTask(task.id)}
                    >
                      <TerminalSquare size={12} aria-hidden />
                      <span>{task.title}</span>
                    </button>
                  ))}
                </details>
              )}
              <button type="button" className="ari-terminal-text-button" onClick={onSettings}>
                <Settings2 size={14} aria-hidden />
                Ari settings
              </button>
            </div>
          </aside>
        )}
        <main className="ari-terminal-desk">
          <div className="ari-terminal-header-row" data-ari-part="terminal-toolbar">
            <div className="ari-terminal-project-controls">
              <TerminalProjectPicker
                projects={projects}
                value={targetProject?.id ?? null}
                onChange={(id) => actions.selectProject(id)}
                onAddProject={onAddProject}
              />
              <span className="ari-terminal-toolbar-divider" />
              <TerminalLayoutPicker
                value={workspace.preset}
                onChange={(value) => actions.preset(value)}
              />
            </div>
            <div className="ari-terminal-space-navigation">
              <div
                className="ari-terminal-tab-strip"
                ref={tabStripRef}
                role="tablist"
                aria-label="Terminal spaces"
                data-ari-part="terminal-tabs"
              >
                {openTasks.map((task) => (
                  <div
                    className="ari-terminal-task-tab"
                    data-selected={task.id === activeTask?.id}
                    data-space-id={task.id}
                    key={task.id}
                  >
                    {renamingTask === task.id ? (
                      <input
                        autoFocus
                        value={taskName}
                        aria-label="Rename space"
                        onFocus={(event) => event.target.select()}
                        onChange={(event) => setTaskName(event.target.value)}
                        onBlur={() => {
                          actions.renameTask(task.id, taskName)
                          setRenamingTask(null)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            actions.renameTask(task.id, taskName)
                            setRenamingTask(null)
                          }
                          if (event.key === 'Escape') setRenamingTask(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={task.id === activeTask?.id}
                        onClick={() => actions.selectTask(task.id)}
                        onDoubleClick={() => {
                          setTaskName(task.title)
                          setRenamingTask(task.id)
                        }}
                      >
                        <TerminalSquare size={13} aria-hidden />
                        <span>{task.title}</span>
                        <span className="ari-terminal-tab-count">
                          {dock.tabs.filter((tab) => tab.workspaceTaskId === task.id).length}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="ari-terminal-tab-close"
                      aria-label={`Park ${task.title}`}
                      title="Park space; terminals keep running"
                      onClick={() => actions.closeTask(task.id)}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="ari-terminal-new-space"
                aria-label="New space"
                title="New space · Ctrl/Cmd+Shift+N"
                disabled={!targetProject || workspace.tasks.length >= MAX_TERMINAL_TASKS}
                onClick={newSpace}
              >
                <Plus size={13} aria-hidden />
                <span>New space</span>
              </button>
              {!!parkedTasks.length && !sidebar && (
                <details className="ari-terminal-parked-menu">
                  <summary title="Reopen parked spaces">
                    <Archive size={13} aria-hidden />
                    <span>{parkedTasks.length}</span>
                  </summary>
                  <div>
                    {parkedTasks.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        onClick={() => actions.selectTask(task.id)}
                      >
                        {task.title}
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <div className="ari-terminal-workspace-actions">
              {activeTask && activePanes.length > 1 && (
                <div className="ari-terminal-toolbar-layout">
                  <button
                    type="button"
                    className="ari-terminal-pane-button"
                    aria-label="Arrange terminals in columns"
                    title="Arrange in columns"
                    onClick={() => actions.arrange(activeTask.id, 'columns')}
                  >
                    <Columns2 size={15} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ari-terminal-pane-button"
                    aria-label="Arrange terminal grid"
                    title="Arrange in grid"
                    onClick={() => actions.arrange(activeTask.id, 'grid')}
                  >
                    <LayoutGrid size={15} aria-hidden />
                  </button>
                </div>
              )}
              <div className="ari-terminal-font-control">
                <button
                  type="button"
                  aria-label="Decrease terminal text size"
                  disabled={prefs.fontSize <= 11}
                  onClick={() => setTerminalPreferences({ fontSize: prefs.fontSize - 1 })}
                >
                  A<span>−</span>
                </button>
                <span>{prefs.fontSize}</span>
                <button
                  type="button"
                  aria-label="Increase terminal text size"
                  disabled={prefs.fontSize >= 24}
                  onClick={() => setTerminalPreferences({ fontSize: prefs.fontSize + 1 })}
                >
                  A<span>+</span>
                </button>
              </div>
              <button
                type="button"
                className="ari-terminal-pane-button"
                aria-label="Terminal workspace preferences"
                title="Customize terminal workspace"
                onClick={() => actions.overlay('preferences')}
              >
                <Settings2 size={15} aria-hidden />
              </button>
              <div className="ari-terminal-new-control">
                <button
                  type="button"
                  className="ari-terminal-new-task"
                  onClick={() => openTerminal()}
                  disabled={!targetProject || !canAddTerminal}
                  title={
                    canAddTerminal
                      ? 'Open a terminal in this space'
                      : 'This space has six panes; open a new space'
                  }
                >
                  <Plus size={14} aria-hidden />
                  New terminal
                </button>
                <button
                  type="button"
                  className="ari-terminal-pane-button"
                  aria-label="Choose terminal program"
                  aria-haspopup="menu"
                  disabled={!targetProject || !canAddTerminal}
                  onClick={(event) => setLaunchMenu(anchorBelow(event.currentTarget))}
                >
                  <ChevronDown size={13} aria-hidden />
                </button>
              </div>
            </div>
          </div>
          <div className="ari-terminal-work-area">
            <div className="ari-terminal-task-stage">
              {!activeTask && (
                <div className="ari-terminal-welcome">
                  <div className="ari-terminal-welcome-mark">
                    <TerminalSquare size={29} strokeWidth={1.25} aria-hidden />
                  </div>
                  <h1>Open a terminal.</h1>
                  <p>
                    Claude Code, Codex, and your shell.
                    <br />
                    Open a tab or split a pane, then get to work.
                  </p>
                  {targetProject ? (
                    <>
                      <div className="ari-terminal-welcome-project">
                        <FolderOpen size={13} aria-hidden />
                        <span>{targetProject.name}</span>
                        <code title={targetProject.path}>
                          {displayTerminalPath(targetProject.path)}
                        </code>
                      </div>
                      <div className="ari-terminal-launch-choices">
                        {profiles.profiles.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            disabled={!item.available}
                            onClick={() => openTerminal(item.id)}
                          >
                            <span>
                              {item.id === 'shell' ? (
                                <TerminalSquare size={20} strokeWidth={1.3} aria-hidden />
                              ) : (
                                <ProviderLogo kind={item.id} size={22} />
                              )}
                            </span>
                            <strong>{item.label}</strong>
                            <small>{item.available ? 'Open terminal' : 'Not installed'}</small>
                            <ArrowRight size={14} aria-hidden />
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="ari-terminal-custom-launch"
                        onClick={() => openTerminal()}
                      >
                        Open a shell for any command
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ari-terminal-new-task" onClick={onAddProject}>
                      <FolderOpen size={14} aria-hidden />
                      Choose a project folder
                    </button>
                  )}
                  {profilesError && (
                    <p role="status" className="ari-terminal-error">
                      CLI detection is unavailable. You can still open a shell.
                    </p>
                  )}
                  <div className="ari-terminal-welcome-hint">
                    <span>Same Ari themes.</span>
                    <span>Native CLI interfaces.</span>
                    <span>Work stays running when you switch views.</span>
                  </div>
                </div>
              )}
              {workspace.tasks.map((task) => {
                const shown = visible && activeTask?.id === task.id
                const tabs = dock.tabs.filter((tab) => tab.workspaceTaskId === task.id)
                const paneIds = new Set(leaves(task.layout.root).map((pane) => pane.terminalId))
                const parked = tabs.filter((tab) => !paneIds.has(tab.id))
                return (
                  <div
                    className="ari-terminal-task-viewport"
                    key={task.id}
                    hidden={!shown}
                    inert={!shown}
                  >
                    <TerminalWorkspaceGrid
                      task={task}
                      tabs={tabs}
                      active={shown}
                      pending={pending}
                      errors={errors}
                      searchTarget={searchTarget}
                      onSearch={setSearchTarget}
                      onLaunch={split}
                      onRestart={(task, tab, pane) => void restart(task, tab, pane)}
                      onStop={(task, tab) => void stop(task, tab)}
                    />
                    {!!parked.length && (
                      <div className="ari-terminal-parked-strip">
                        <Archive size={12} aria-hidden />
                        <span>Parked</span>
                        {parked.map((tab) => (
                          <button
                            type="button"
                            key={tab.id}
                            onClick={() => {
                              const leaf = leaves(task.layout.root).find((pane) => !pane.terminalId)
                              const target = leaf?.paneId ?? activePaneOf(task.layout)
                              actions.attach(
                                task.id,
                                tab.id,
                                target,
                                leaf
                                  ? undefined
                                  : leaves(task.layout.root).length < 6
                                    ? 'right'
                                    : undefined,
                              )
                            }}
                          >
                            {tab.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {workspace.panel && scopedTask && (
              <aside className="ari-terminal-tool-panel">
                <header>
                  <button
                    type="button"
                    data-selected={workspace.panel === 'files'}
                    onClick={() => actions.panel('files')}
                  >
                    <FileText size={13} aria-hidden />
                    Files
                  </button>
                  <button
                    type="button"
                    data-selected={workspace.panel === 'changes'}
                    onClick={() => actions.panel('changes')}
                  >
                    <GitBranch size={13} aria-hidden />
                    Changes
                  </button>
                  <span />
                  <button
                    type="button"
                    className="ari-terminal-pane-button"
                    aria-label="Close terminal tools"
                    onClick={() => actions.panel(null)}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </header>
                <div>
                  {workspace.panel === 'files' ? (
                    <FileExplorer
                      root={scopedTask.cwd}
                      scope={{ projectId: scopedTask.projectId }}
                    />
                  ) : (
                    <ChangesView
                      projectId={scopedTask.projectId}
                      initialTab={workspace.reviewTab}
                      onTabChange={(tab) => actions.panel('changes', tab)}
                    />
                  )}
                </div>
              </aside>
            )}
          </div>
          <footer className="ari-terminal-statusbar">
            <span className="ari-terminal-status-dot" />
            <span>This computer</span>
            <span className="ari-terminal-status-separator" />
            <span>
              {taskTabs.length} {taskTabs.length === 1 ? 'terminal' : 'terminals'}
            </span>
            {activeTab && (
              <>
                <span className="ari-terminal-status-separator" />
                <span>
                  {activeStatus.state === 'exited' || activeStatus.state === 'missing'
                    ? 'Stopped'
                    : 'Interactive'}
                </span>
              </>
            )}
            <span className="ari-terminal-toolbar-spacer" />
            <button type="button" onClick={() => actions.panel(workspace.panel ? null : 'files')}>
              <FileText size={12} aria-hidden />
              Files
            </button>
            <button
              type="button"
              onClick={() => actions.panel(workspace.panel === 'changes' ? null : 'changes')}
            >
              <GitBranch size={12} aria-hidden />
              Changes
            </button>
            <button type="button" onClick={onPalette}>
              <span>Ctrl/Cmd ⇧ P</span>Commands
            </button>
          </footer>
        </main>
        {prefix && visible && (
          <div className="ari-terminal-prefix-hint" role="status">
            <strong>Ctrl+B</strong>
            <span>c New space</span>
            <span>% Split right</span>
            <span>" Split below</span>
            <span>h j k l Focus</span>
            <span>z Zoom</span>
            <span>Esc Cancel</span>
          </div>
        )}
      </div>
      {launchMenu && visible && (
        <ContextMenu
          anchor={launchMenu}
          label="Open terminal"
          items={profiles.profiles.map((item) => ({
            id: item.id,
            label: item.label,
            disabled: !item.available,
            disabledReason: item.available ? undefined : 'Not installed on this computer',
            onSelect: () => openTerminal(item.id),
          }))}
          onClose={() => setLaunchMenu(null)}
        />
      )}
      {launchError && visible && (
        <p className="ari-terminal-launch-error" role="alert">
          {launchError}
        </p>
      )}
      <TerminalWorkspaceSettings
        open={workspace.overlay === 'preferences' && visible}
        onClose={() => actions.overlay(null)}
      />
      <Dialog
        open={workspace.overlay === 'usage' && visible}
        onOpenChange={(open) => {
          if (!open) actions.overlay(null)
        }}
      >
        <Dialog.Content size="lg" className="ari-terminal-usage-dialog">
          <button
            type="button"
            className="ari-terminal-pane-button"
            aria-label="Close usage"
            onClick={() => actions.overlay(null)}
          >
            <X size={16} aria-hidden />
          </button>
          <Dialog.Title className="sr-only">Provider usage</Dialog.Title>
          <Dialog.Description className="sr-only">
            Usage for your Ari provider accounts.
          </Dialog.Description>
          <UsagePage />
        </Dialog.Content>
      </Dialog>
    </SessionClientProvider>
  )
}
