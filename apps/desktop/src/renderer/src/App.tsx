import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, FolderPlus } from 'lucide-react'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { SessionImportDialog } from './features/providers'
import { useUpdateToasts } from './features/providers/use-update-toasts'
import { useAppUpdateToast } from './features/updates'
import type { RpcResults, SessionEventFrame, SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { rpc } from './lib/rpc'
import { themePersistence } from './lib/theme-persistence'
import { Titlebar } from './shell/Titlebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import {
  moveProjectInList,
  projectMoveForDelta,
  shellRootFor,
  sidebarOrder,
} from './features/session/session-nav'
import { descendantIds } from './features/session/session-tree'
import { TerminalDock } from './features/terminal'
import { SettingsWorkspace, type SettingsSectionId } from './features/settings'
import { KeyboardCheatSheet } from './features/settings/KeyboardCheatSheet'
import { ChangesView } from './features/changes'
import { openProjectViaPicker } from './features/projects/open-project'
import { UsagePage } from './features/usage/UsagePage'
import { FileExplorer } from './features/files/FileExplorer'
import { CommandPalette } from './features/palette/CommandPalette'
import { useCommands } from './features/palette/useCommands'
import { ContentSearchOverlay } from './features/search'
import { AwakenSplash, AWAKEN_MAX_MS } from './features/moment'
import { useSessionActivity } from './features/session/use-session-activity'
import { SplitView } from './features/split/SplitView'
import { splitLayoutActions, useSplitLayout } from './features/split/use-split-layout'
import { activeSessionOf, paneCount, sessionIdsInPanes } from './features/split/split-layout'
import { SidebarHeader, SessionsUnderProjects, type SidebarNavId } from './shell/Sidebar'
import {
  ContextMenu,
  anchorBelow,
  type ContextMenuItem,
  type MenuAnchor,
} from './shell/ContextMenu'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { useSessionCollapse } from './shell/use-session-collapse'
import { useSidebarView } from './shell/use-sidebar-view'
import {
  DOCK_WIDTH_BOUNDS,
  SIDEBAR_WIDTH_BOUNDS,
  useDockWidth,
  useSidebarWidth,
} from './shell/use-pane-width'
import { WelcomePanel } from './features/welcome'
import './features/transcript/transcript.css'

type InspectorId = Exclude<SidebarNavId, 'session' | 'settings'>

/** Rail headings, and the accessible name of the rail itself. */
const INSPECTOR_TITLES: Record<InspectorId, string> = {
  terminal: 'Terminal',
  changes: 'Changes',
  files: 'Files',
  usage: 'Usage',
}

/** Full project registry rows; ids feed lookups, paths feed git/fs panes. */
type ProjectRow = RpcResults['project.list'][number]

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
  effort: string | null
}

function Shell() {
  const [inspector, setInspector] = useState<InspectorId | null>(null)
  // Usage and Changes get the full page — they're rooms. Files and the terminal
  // are tools, so they dock to the trailing rail beside the transcript.
  const [fullPage, setFullPage] = useState<'usage' | 'changes' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  // Which session is active is now a property of the panes: it is whatever the
  // focused pane is showing, so every single-session view in the shell — the
  // workspace lookup below, Changes, the sidebar's highlighted row — follows
  // the pane the user is actually in rather than the last row they clicked.
  const layout = useSplitLayout()
  const activeSessionId = activeSessionOf(layout)
  const visibleSessionIds = useMemo(() => sessionIdsInPanes(layout), [layout])
  const { activityOf, acknowledge, forget } = useSessionActivity(visibleSessionIds)
  const [importProjectId, setImportProjectId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * The pending "start a session" request: where to anchor the project picker,
   * plus any defaults the entry point wants applied to the session it creates.
   */
  const [newSessionRequest, setNewSessionRequest] = useState<{
    anchor: MenuAnchor
    overrides?: Partial<SessionDefaults>
  } | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [sessionWorkspace, setSessionWorkspace] = useState<{
    id: string
    path: string | null
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (activeSessionId) {
      void rpc
        .invoke('session.workspace', { sessionId: activeSessionId })
        .then(({ path }) => {
          if (!cancelled) setSessionWorkspace({ id: activeSessionId, path })
        })
        .catch((error: unknown) => log.warn('workspace resolution failed', error))
    }
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
  const [defaults, setDefaults] = useState<SessionDefaults>({
    // Ari Core is the safe default: it works with a user-configured endpoint
    // and never depends on an installed CLI. Detection below upgrades this.
    driverKind: 'ari-core',
    modelId: null,
    permissionMode: 'ask',
    effort: null,
  })

  /**
   * Composer seeds per session. `defaults` stays the seed for sessions that
   * have not loaded yet; with several panes mounted, one shared value would
   * leave every pane's model and permission chips showing whichever session
   * happened to load last.
   */
  const [defaultsBySession, setDefaultsBySession] = useState<Record<string, SessionDefaults>>({})
  const defaultsFor = useCallback(
    (sessionId: string): SessionDefaults => defaultsBySession[sessionId] ?? defaults,
    [defaultsBySession, defaults],
  )
  const writeDefaults = useCallback((sessionId: string, next: SessionDefaults): void => {
    setDefaultsBySession((prev) =>
      prev[sessionId] === next ? prev : { ...prev, [sessionId]: next },
    )
  }, [])

  // Sidebar collapse: ephemeral UI state, so localStorage (not engine settings)
  // is the right home. Ctrl+B toggles; a rail button restores it.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('ari.sidebar.open') !== '0',
  )
  const sidebar = useSidebarWidth()
  const sidebarSearchRef = useRef<HTMLInputElement>(null)
  const dock = useDockWidth()
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      localStorage.setItem('ari.sidebar.open', open ? '0' : '1')
      return !open
    })
  }, [])

  // The terminal is a tool the transcript keeps working next to, so Ctrl+`
  // docks and undocks the rail instead of navigating anywhere.
  const toggleTerminal = useCallback(() => {
    setFullPage(null)
    setInspector((prev) => (prev === 'terminal' ? null : 'terminal'))
  }, [])

  // Switching chats must not kill a running shell; every other rail still
  // yields to the session view the way it always has.
  const clearTransientInspector = useCallback(() => {
    setInspector((prev) => (prev === 'terminal' ? prev : null))
  }, [])

  // Visiting a session lands on it and clears its settled badge — done/error
  // sticks until the user has seen what the agent did.
  const selectSession = useCallback(
    (id: string) => {
      // A session already on screen is focused where it is; anything else
      // replaces what the focused pane was showing, which is the tmux reading
      // of a click in the session list.
      const paneId = splitLayoutActions.paneOf(id) ?? layout.focusedPaneId
      splitLayoutActions.assign(paneId, id)
      clearTransientInspector()
      // Selecting a chat must land on it, not leave Usage/Changes up.
      setFullPage(null)
    },
    [layout, clearTransientInspector],
  )

  // A session that has just come on screen has been seen: it is the arrival in
  // a pane, not every later focus change, that clears the settled badge — and
  // only for the panes that had not been showing it already.
  const visibleRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const now = sessionIdsInPanes(layout)
    for (const id of now) {
      if (!visibleRef.current.has(id)) acknowledge(id)
    }
    visibleRef.current = new Set(now)
  }, [layout, acknowledge])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  // Set on the first successful list, so the restored panes are never pruned
  // against the empty session state the shell starts from.
  const sessionsLoadedRef = useRef(false)

  const refreshSessions = useCallback((): void => {
    void rpc
      .invoke('session.list')
      .then((next) => {
        sessionsLoadedRef.current = true
        setSessions(next)
      })
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  // A pane remembers what it was showing across launches. A session that is
  // gone by the time the list arrives blanks its pane rather than leaving the
  // shell pointed at something that no longer exists.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return
    splitLayoutActions.prune(new Set(sessions.map((session) => session.id)))
  }, [sessions])

  // Late-bound so the global key handler (registered before the session
  // starters exist) can still open the new-session rail.
  const newSessionRef = useRef<(() => void) | null>(null)

  useEffect(refreshSessions, [])

  // Live sidebar: the engine names a session on its first prompt and bumps
  // message counts as turns run. Without this feed the list only refreshed
  // on explicit actions, so rows kept stale titles and pristine-session
  // reuse kept matching a session that had already started chatting.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = rpc.subscribe('session.events', {}, (payload) => {
      // The contract types frames loosely (`event?: unknown`); only the
      // journal event's discriminant is needed here.
      const event = (payload as Partial<SessionEventFrame> | null)?.event as
        { type?: string } | undefined
      if (
        !event ||
        (event.type !== 'user.message.added' &&
          event.type !== 'session.updated' &&
          event.type !== 'turn.settled' &&
          event.type !== 'session.created' &&
          !event.type?.startsWith('child.session.'))
      ) {
        // Streaming deltas and per-turn noise must not refetch the list.
        return
      }
      if (pending !== null) return // coalescing; the scheduled fetch sees this too
      pending = setTimeout(() => {
        pending = null
        refreshSessions()
      }, 250)
    })
    return () => {
      if (pending !== null) clearTimeout(pending)
      unsubscribe()
    }
  }, [refreshSessions])

  useEffect(() => {
    void rpc
      .invoke('project.list')
      .then(setProjects)
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  // First available CLI becomes the default driver at boot; when none is
  // installed, sessions fall back to Ari Core (endpoint-powered).
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        const installed = detections.find((d) => d.binaryPath !== null && d.kind !== 'ari-core')
        if (installed) {
          setDefaults((prev) =>
            prev.driverKind === 'ari-core'
              ? { ...prev, driverKind: installed.kind as DriverKind }
              : prev,
          )
        }
      })
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  const commands = useCommands({
    onNavigate: (view) => {
      if (view === 'settings') {
        setSettingsOpen(true)
      } else if (view === 'sessions') {
        clearTransientInspector()
      } else if (view === 'terminal') {
        setFullPage(null)
        setInspector('terminal')
      } else {
        setInspector(view)
      }
      setPaletteOpen(false)
    },
    onOpenGallery: () => {
      setGalleryOpen(true)
      setPaletteOpen(false)
    },
    onOpenSearch: () => {
      setSearchOpen(true)
      setPaletteOpen(false)
    },
  })

  // Sidebar-visible order — the same sequence Mod+1..9 and Ctrl+Tab traverse.
  // Grouped by the open projects in the Projects view; the flat recency list
  // in the Sessions view. Either way keyboard order matches what is rendered.
  const openProjects = useMemo(() => projects.filter((p) => p.open), [projects])
  const { collapsed: collapsedChildren } = useSessionCollapse()
  const { view: sidebarView } = useSidebarView()
  const navOrder = useMemo(
    () => sidebarOrder(sessions, sidebarView === 'sessions' ? [] : openProjects),
    [sessions, openProjects, sidebarView, collapsedChildren],
  )

  const refreshProjects = useCallback((): void => {
    void rpc
      .invoke('project.list')
      .then(setProjects)
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  // Sidebar order is the stored registry order: slot the project before
  // `beforeId` (null = last). Applied optimistically so the spring tracks the
  // drop, then persisted; a failed persist resyncs from disk.
  const moveProject = useCallback(
    (id: string, beforeId: string | null): void => {
      setProjects((prev) => moveProjectInList(prev, id, beforeId))
      void rpc.invoke('project.move', { id, beforeId }).catch((error: unknown) => {
        log.warn('rpc call failed', error)
        refreshProjects()
      })
    },
    [refreshProjects],
  )

  // Native picker → open; a cancelled picker resolves to null (silent no-op).
  // With a project id, the picker starts near that project's folder (Locate).
  const openProjectViaDialog = useCallback(
    (projectId?: string): void => {
      const folder = projectId
        ? projects.find((p) => p.id === projectId)?.path.replace(/[/\\][^/\\]+$/, '')
        : undefined
      void openProjectViaPicker(folder)
        .then((project) => {
          if (project !== null) refreshProjects()
        })
        .catch((error: unknown) => log.warn('rpc call failed', error))
    },
    [refreshProjects, projects],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newSessionRef.current?.()
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
      }
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        // Mod+1..9 jumps to the nth sidebar row (T3/comet session jumping).
        const target = navOrder[Number(e.key) - 1]
        if (target && !paletteOpen && !searchOpen) {
          e.preventDefault()
          selectSession(target.id)
        }
      }
      if (e.ctrlKey && e.key === 'Tab') {
        // Ctrl+Tab / Ctrl+Shift+Tab cycle sessions (cross-platform literal).
        if (navOrder.length > 1 && !paletteOpen && !searchOpen) {
          e.preventDefault()
          const index = navOrder.findIndex((s) => s.id === activeSessionId)
          const delta = e.shiftKey ? -1 : 1
          const next =
            index === -1
              ? // No active session: forward opens the newest, backward the oldest.
                delta === 1
                ? navOrder[0]
                : navOrder[navOrder.length - 1]
              : navOrder[(index + delta + navOrder.length) % navOrder.length]
          if (next) {
            selectSession(next.id)
          }
        }
      }
      if (e.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false)
          return
        }
        if (settingsOpen) setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, settingsOpen, navOrder, activeSessionId, toggleTerminal, selectSession])

  const createSession = useCallback(
    (projectId: string, overrides?: Partial<SessionDefaults>): void => {
      const effective = { ...defaults, ...overrides }
      // Reuse the newest pristine (zero-message) session when its config is
      // compatible — spamming ✎ must not pile up empty chats.
      const reusable = sessions.find(
        (s) =>
          s.projectId === projectId &&
          s.messageCount === 0 &&
          (overrides === undefined || overrides.driverKind === undefined),
      )
      if (reusable) {
        if (overrides) setDefaults(effective)
        splitLayoutActions.assign(layout.focusedPaneId, reusable.id)
        clearTransientInspector()
        return
      }
      void rpc
        .invoke('session.create', {
          projectId,
          title: 'New session',
          driverKind: effective.driverKind,
          modelId: effective.modelId,
          permissionMode: effective.permissionMode,
          effort: effective.effort,
        })
        .then(({ sessionId }) => {
          if (overrides) setDefaults(effective)
          splitLayoutActions.assign(layout.focusedPaneId, sessionId)
          clearTransientInspector()
          refreshSessions()
        })
        .catch((error: unknown) => log.warn('rpc call failed', error))
    },
    [defaults, sessions, layout, refreshSessions, clearTransientInspector],
  )

  /**
   * Single door for every "new session" affordance. A session always belongs
   * to a project, so with none registered the folder picker comes first and
   * the session is created in whatever the user picks. Otherwise the rail
   * asks which project to run in — the answer is no longer implied, since
   * every session now has a real one.
   */
  const beginNewSession = useCallback(
    (anchor: MenuAnchor, overrides?: Partial<SessionDefaults>): void => {
      if (projects.length === 0) {
        void openProjectViaPicker()
          .then((project) => {
            if (project === null) return // cancelled picker stays put
            refreshProjects()
            createSession(project.id, overrides)
          })
          .catch((error: unknown) => log.warn('project open failed', error))
        return
      }
      setNewSessionRequest({ anchor, overrides })
    },
    [projects.length, refreshProjects, createSession],
  )

  /**
   * Keyboard-invoked new sessions anchor to the sidebar's own button so the
   * rail appears under the control the shortcut stands in for; a collapsed
   * sidebar (no button rendered) falls back to the top of the content area.
   */
  const beginNewSessionFromKeyboard = useCallback((): void => {
    const trigger = document.querySelector<HTMLElement>('[data-new-session-trigger]')
    beginNewSession(trigger ? anchorBelow(trigger) : { x: 24, y: 88 })
  }, [beginNewSession])

  const closeNewSessionMenu = useCallback(() => setNewSessionRequest(null), [])
  newSessionRef.current = beginNewSessionFromKeyboard

  const newSessionMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      ...projects.map((project) => ({
        id: project.id,
        label: project.name,
        onSelect: () => {
          setNewSessionRequest(null)
          createSession(project.id, newSessionRequest?.overrides)
        },
      })),
      {
        id: 'add-project',
        label: 'Add project…',
        icon: FolderPlus,
        onSelect: () => {
          const overrides = newSessionRequest?.overrides
          setNewSessionRequest(null)
          void openProjectViaPicker()
            .then((project) => {
              if (project === null) return
              refreshProjects()
              createSession(project.id, overrides)
            })
            .catch((error: unknown) => log.warn('project open failed', error))
        },
      },
    ],
    [projects, createSession, refreshProjects, newSessionRequest],
  )

  const selectWorkspaceTool = useCallback((id: SidebarNavId): void => {
    if (id === 'settings') {
      setSettingsOpen(true)
      setFullPage(null)
      setInspector(null)
      return
    }
    setSettingsOpen(false)
    if (id === 'session') {
      setInspector(null)
      setFullPage(null)
      return
    }
    if (id === 'usage' || id === 'changes') {
      setInspector(null)
      setFullPage((prev) => (prev === id ? null : id))
      return
    }
    setFullPage(null)
    setInspector((prev) => (prev === id ? null : id))
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  // The usage chip names the driver of whichever session is active, which in a
  // split is the focused pane's — not the shell's seed for new sessions.
  const activeDriverKind =
    activeSessionId === null ? defaults.driverKind : defaultsFor(activeSessionId).driverKind
  // The explorer roots at the active session's project, falling back to the
  // first registered project so the pane is never dead on arrival.
  const activeProjectPath =
    activeSessionId !== null
      ? sessionWorkspace?.id === activeSessionId
        ? sessionWorkspace.path
        : null
      : (projects.find((p) => p.id === activeSession?.projectId)?.path ?? projects[0]?.path ?? null)
  // Capability scope matching activeProjectPath above: a session workspace
  // resolves by session id, a project folder by project id. The explorer
  // sends this scope plus relative paths only — absolute paths never cross
  // IPC for fs.* calls.
  const activeScopeProjectId = activeSession?.projectId ?? projects[0]?.id
  const activeScope =
    activeSessionId !== null
      ? sessionWorkspace?.id === activeSessionId
        ? { sessionId: activeSessionId }
        : null
      : activeScopeProjectId !== undefined
        ? { projectId: activeScopeProjectId }
        : null
  // Where a shell can actually run — the rule and its precedence live in
  // `shellRootFor`, which is unit-tested. A null answer is what makes the rail
  // offer a project instead of a spawn the main process would refuse.
  const shellRoot = useMemo(
    () => shellRootFor(activeSession, activeProjectPath, projects),
    [activeSession, activeProjectPath, projects],
  )

  if (settingsOpen) {
    return (
      <div className="ari-glass-pane flex h-full flex-col">
        <Titlebar usage={{ sessionId: activeSessionId, kind: activeDriverKind }} />
        <SettingsWorkspace
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onBack={() => setSettingsOpen(false)}
          onOpenTerminal={() => {
            setSettingsOpen(false)
            setFullPage(null)
            setInspector('terminal')
          }}
        />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={commands}
        />
        <KeyboardCheatSheet />
      </div>
    )
  }

  if (galleryOpen) {
    return (
      <div className="ari-glass-pane flex h-full flex-col bg-bg">
        <header className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center gap-2 pl-3">
          <span className="text-fg text-xs font-semibold tracking-[0.18em]">ARI</span>
          <span className="text-fg-subtle text-xs">/</span>
          <span className="text-fg-muted text-xs">Component gallery</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setGalleryOpen(false)}
            className="mr-3 flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-3 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            ← Back to workspace
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <GalleryView />
        </div>
      </div>
    )
  }

  return (
    <div className="ari-glass-pane flex h-full flex-col">
      <Titlebar
        activeTool={settingsOpen ? 'settings' : (fullPage ?? inspector)}
        onSelectTool={selectWorkspaceTool}
        usage={{ sessionId: activeSessionId, kind: activeDriverKind }}
        onExpandSidebar={sidebarOpen ? undefined : toggleSidebar}
      />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? (
          <aside className="ari-glass flex shrink-0 flex-col" style={{ width: sidebar.width }}>
            <SidebarHeader
              onSearch={() => sidebarSearchRef.current?.focus()}
              onCollapse={toggleSidebar}
            />
            <SessionsUnderProjects
              sessions={sessions}
              projects={openProjects}
              knownProjectNames={projects.map((p) => ({ id: p.id, name: p.name }))}
              searchInputRef={sidebarSearchRef}
              onNewSession={beginNewSession}
              onOpenProject={openProjectViaDialog}
              onNewSessionInProject={(projectId) => createSession(projectId)}
              onImportSessions={setImportProjectId}
              onRevealProject={(projectId) => {
                const path = projects.find((p) => p.id === projectId)?.path
                if (path === undefined) return
                void rpc
                  .invoke('shell.revealPath', { path })
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onCloseProject={(projectId) => {
                void rpc
                  .invoke('project.close', { id: projectId })
                  .then(refreshProjects)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onRemoveProject={(projectId) => {
                void rpc
                  .invoke('project.remove', { id: projectId })
                  .then(refreshProjects)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onReorderProject={moveProject}
              onMoveProject={(projectId, delta) => {
                const move = projectMoveForDelta(
                  openProjects.map((p) => p.id),
                  projectId,
                  delta,
                )
                if (move) moveProject(move.id, move.beforeId)
              }}
              onLocateProject={openProjectViaDialog}
              activeSessionId={activeSessionId}
              activityOf={activityOf}
              onSelect={selectSession}
              onRename={(id, title) => {
                void rpc
                  .invoke('command.dispatch', {
                    command: { type: 'session.update', sessionId: id, title },
                  })
                  .then(refreshSessions)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onDelete={(id) => {
                const dropped = new Set([id, ...descendantIds(sessions, id)])
                for (const gone of dropped) forget(gone)
                void rpc
                  .invoke('session.destroy', { sessionId: id })
                  // The refreshed list blanks the panes those sessions were in.
                  .then(refreshSessions)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onTogglePin={(id, pinned) => {
                void rpc
                  .invoke('command.dispatch', {
                    command: { type: 'session.update', sessionId: id, pinned },
                  })
                  .then(refreshSessions)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
              onToggleArchive={(id, archived) => {
                void rpc
                  .invoke('command.dispatch', {
                    command: { type: 'session.update', sessionId: id, archived },
                  })
                  .then(refreshSessions)
                  .catch((error: unknown) => log.warn('rpc call failed', error))
              }}
            />
          </aside>
        ) : null}

        {sidebarOpen ? (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuenow={sidebar.width}
            aria-valuemin={SIDEBAR_WIDTH_BOUNDS.min}
            aria-valuemax={SIDEBAR_WIDTH_BOUNDS.max}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            {...sidebar.handleProps}
            className={`w-1 shrink-0 cursor-col-resize transition-colors focus-visible:outline-none focus-visible:bg-accent ${
              sidebar.dragging ? 'bg-accent' : 'bg-transparent hover:bg-accent-subtle'
            }`}
          />
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col bg-bg border-l border-border/50">
          {fullPage !== null ? (
            <div className="min-h-0 flex-1">
              {fullPage === 'usage' ? (
                <ErrorBoundary label="Usage">
                  <UsagePage />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary label="Changes">
                  <ChangesView
                    sessionId={activeSessionId}
                    projectId={activeSession?.projectId ?? null}
                  />
                </ErrorBoundary>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="min-h-0 min-w-0 flex-1">
                {activeSessionId === null && paneCount(layout) === 1 ? (
                  // Nothing open at all: the welcome panel is still the view.
                  <ErrorBoundary label="Welcome">
                    <WelcomePanel
                      hasProjects={projects.length > 0}
                      onCreateSession={beginNewSession}
                      onConnect={(endpointId, anchor) =>
                        beginNewSession(anchor, {
                          driverKind: 'ari-core',
                          modelId: `ep:${endpointId}`,
                        })
                      }
                    />
                  </ErrorBoundary>
                ) : (
                  <ErrorBoundary label="Session">
                    <SplitView
                      layout={layout}
                      titleOf={(id) => sessions.find((s) => s.id === id)?.title ?? null}
                      onFocus={splitLayoutActions.focus}
                      onClose={splitLayoutActions.close}
                      renderSession={(sessionId, paneId) => (
                        // Keyed by pane *and* session, so a pane that changes what
                        // it shows remounts: composer seeds and review notes belong
                        // to the session, not to the position it sits in.
                        <SessionView
                          key={`${paneId}:${sessionId}`}
                          sessionId={sessionId}
                          defaults={defaultsFor(sessionId)}
                          onDefaultsChange={(next) => writeDefaults(sessionId, next)}
                          // A child session opens in the pane it was opened from,
                          // rather than yanking the whole shell to it.
                          onOpenSession={(childId) => splitLayoutActions.assign(paneId, childId)}
                          activityOf={activityOf}
                          childSessions={sessions.filter(
                            (session) => session.parentSessionId === sessionId && !session.archived,
                          )}
                        />
                      )}
                    />
                  </ErrorBoundary>
                )}
              </div>
              {inspector ? (
                <>
                  <div
                    role="separator"
                    aria-label="Resize panel"
                    aria-orientation="vertical"
                    aria-valuenow={dock.width}
                    aria-valuemin={DOCK_WIDTH_BOUNDS.min}
                    aria-valuemax={DOCK_WIDTH_BOUNDS.max}
                    tabIndex={0}
                    title="Drag to resize · double-click to reset"
                    {...dock.handleProps}
                    className={`w-1 shrink-0 cursor-col-resize transition-colors focus-visible:outline-none focus-visible:bg-accent ${
                      dock.dragging ? 'bg-accent' : 'bg-transparent hover:bg-accent-subtle'
                    }`}
                  />
                  <aside
                    role="complementary"
                    aria-label={INSPECTOR_TITLES[inspector]}
                    className="flex shrink-0 flex-col border-l border-border"
                    style={{ width: dock.width, maxWidth: '60vw' }}
                  >
                    {inspector === 'terminal' ? (
                      <div className="min-h-0 flex-1">
                        <ErrorBoundary label="Terminal">
                          <TerminalDock
                            cwd={shellRoot}
                            onAddProject={() => openProjectViaDialog()}
                            onClose={() => setInspector(null)}
                          />
                        </ErrorBoundary>
                      </div>
                    ) : (
                      <>
                        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
                          <span className="text-xs font-medium text-fg">
                            {INSPECTOR_TITLES[inspector]}
                          </span>
                          <div className="flex-1" />
                          <button
                            type="button"
                            aria-label="Close inspector"
                            onClick={() => setInspector(null)}
                            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                          >
                            <X size={13} />
                          </button>
                        </div>
                        <div className="min-h-0 flex-1">
                          {inspector === 'changes' ? (
                            <ErrorBoundary label="Changes">
                              <ChangesView
                                sessionId={activeSessionId}
                                projectId={activeSession?.projectId ?? null}
                              />
                            </ErrorBoundary>
                          ) : activeProjectPath && activeScope ? (
                            <FileExplorer root={activeProjectPath} scope={activeScope} />
                          ) : (
                            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-subtle">
                              Open a project first — the explorer browses its folder.
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </aside>
                </>
              ) : null}
            </div>
          )}
        </main>
      </div>

      {importProjectId !== null ? (
        <SessionImportDialog
          open
          project={
            projects.find((project) => project.id === importProjectId) ?? {
              id: importProjectId,
              name: 'Project',
            }
          }
          onClose={() => setImportProjectId(null)}
          onImported={(sessionId) => {
            refreshSessions()
            selectSession(sessionId)
          }}
        />
      ) : null}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ContentSearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        root={activeProjectPath}
        scope={activeScope}
      />
      <KeyboardCheatSheet />
      {newSessionRequest !== null ? (
        <ContextMenu
          anchor={newSessionRequest.anchor}
          label="New session in project"
          items={newSessionMenuItems}
          onClose={closeNewSessionMenu}
        />
      ) : null}
    </div>
  )
}

/** Theme, motion, and toast context for the whole renderer tree. */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider persistence={themePersistence}>
      <MotionProvider>
        <ToastProvider>
          <UpdateToastWatcher />
          {children}
        </ToastProvider>
      </MotionProvider>
    </ThemeProvider>
  )
}

/** Headless: announces provider updates once the toast context exists. */
function UpdateToastWatcher() {
  useUpdateToasts()
  useAppUpdateToast()
  return null
}

const log = createLogger('app:shell')

/**
 * Startup: the launch animation is the window's own first frame, so the
 * splash overlays the shell rather than living in a second window. The shell
 * mounts underneath as soon as the engine answers, and the splash's outro
 * wipes away to reveal it already painted.
 */
export function App() {
  const [booted, setBooted] = useState(false)
  const [launched, setLaunched] = useState(false)

  useEffect(() => {
    void rpc
      .invoke('ping')
      .then(() => setBooted(true))
      .catch(() => setBooted(true))
    // A wedged engine must not hide the UI behind the splash forever; the
    // splash lifts at the same ceiling, so the shell is what's underneath.
    const ceiling = setTimeout(() => setBooted(true), AWAKEN_MAX_MS)
    return () => clearTimeout(ceiling)
  }, [])

  const finishLaunch = useCallback(() => {
    setLaunched(true)
    delete document.documentElement.dataset['ariBooting']
  }, [])

  return (
    <AppProviders>
      {booted ? <Shell /> : null}
      {launched ? null : <AwakenSplash ready={booted} onDone={finishLaunch} />}
    </AppProviders>
  )
}
