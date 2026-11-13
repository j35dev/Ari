import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVoicePlayback } from './features/aria/use-voice-playback'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import { AnimatePresence, motion, useReducedMotionConfig } from 'motion/react'
import { transitions } from '@ari/ui/motion'
import { useEngineSettings } from './features/settings/useEngineSettings'
import { applyAppearance, cacheAppearance } from './lib/appearance'
import { ToastProvider, useToast } from '@ari/ui/toast'
import { SessionImportDialog } from './features/providers'
import { useUpdateToasts } from './features/providers/use-update-toasts'
import { useAppUpdateToast } from './features/updates'
import type {
  BrowserTabState,
  AppOpenTarget,
  RpcResults,
  SessionEventFrame,
  SessionSummary,
} from '@ari/contracts/rpc'
import { navigateFrameSchema } from '@ari/contracts/rpc'
import { useAppNavigation } from './use-app-navigation'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { DEFAULT_PERMISSION_MODE } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { rpc } from './lib/rpc'
import { themePersistence } from './lib/theme-persistence'
import { SidebarFooter } from './shell/SidebarFooter'
import { PanelTabs, type PanelTab } from './shell/PanelTabs'
import { outlineButton } from './lib/recipes'
import { ScopedTitlebar } from './shell/ScopedTitlebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import {
  createSessionClient,
  parseSessionViewKey,
  sessionViewKey,
  SessionClientProvider,
  type SessionScope,
} from './features/session/session-client'
import { useMachineProjects } from './features/machines/use-machine-projects'
import { ProjectDraftPane } from './features/machines/ProjectDraftPane'
import { DraftHandoff } from './features/machines/DraftHandoff'
import {
  readProjectDrafts,
  writeProjectDrafts,
  type ProjectDraftEntry,
} from './features/machines/project-draft-registry'
import type { ComposerSeed } from './features/composer/Composer'
import { groupRepositories, type RepositoryGroup } from './features/machines/repository-groups'
import { SessionKeepAlive } from './features/session/SessionKeepAlive'
import { loadLastPick, nextLastPick, saveLastPick } from './features/composer/last-pick'
import type { LastPick } from './features/composer/last-pick'
import { keepAliveActions } from './features/session/session-keep-alive'
import {
  UNFILED_GROUP_ID,
  moveProjectInList,
  projectMoveForDelta,
  sessionsViewOrder,
  shellRootFor,
  sidebarOrder,
} from './features/session/session-nav'
import { descendantIds, parentOf } from './features/session/session-tree'
import { LINK_FAILED_EVENT } from './lib/external-links'
import { BrowserPanel, browserTabFor } from './features/browser/BrowserPanel'
import { deleteSessionDraftIntent } from './features/composer/draft-recovery-store'
import { deleteSessionDraftText } from './features/composer/use-drafts'
import { writeReviewDrafts } from './features/changes/review-drafts'
import { TerminalDock, TerminalPane } from './features/terminal'
import {
  openTerminalTab,
  subscribeTerminalDock,
  terminalDockState,
} from './features/terminal/terminal-dock'
import { SettingsDialog, type SettingsSectionId } from './features/settings'
import { HubWorkspace } from './features/github'
import { KeyboardCheatSheet } from './features/settings/KeyboardCheatSheet'
import { ChangesView } from './features/changes'
import { openCheckedOutWorktree } from './features/changes/open-request-worktree'
import { rememberReviewRange } from './features/changes/review-drafts'
import { openProjectViaPicker } from './features/projects/open-project'
import { UsagePage } from './features/usage/UsagePage'
import { ProviderUsagePill } from './features/usage/ProviderUsagePill'
import { FileExplorer } from './features/files/FileExplorer'
import { CommandPalette } from './features/palette/CommandPalette'
import { useCommands } from './features/palette/useCommands'
import { ContentSearchOverlay } from './features/search'
import { AwakenSplash, AWAKEN_MAX_MS } from './features/moment'
import { useSessionActivity } from './features/session/use-session-activity'
import { formatPaneTitle } from './features/split/pane-title'
import { SplitView } from './features/split/SplitView'
import {
  splitLayoutActions,
  splitLayoutSnapshot,
  useSplitLayout,
} from './features/split/use-split-layout'
import {
  MAX_SPACES,
  SpaceTabs,
  recentSpaces,
  spaceActions,
  spaceStoreSnapshot,
  spaceStatus,
  useSpaces,
  useSpaceSwipe,
} from './features/spaces'
import { focusNeighbour } from './features/split/split-geometry'
import {
  MAX_PANES,
  activePaneOf,
  assignSession,
  assignTerminal,
  activeSessionOf,
  isBlankLeaf,
  leaves,
  paneCount,
  sessionsOnScreen,
  terminalIdsInPanes,
  type PaneEdge,
} from './features/split/split-layout'
import { SidebarHeader, SessionsUnderProjects, type SidebarNavId } from './shell/Sidebar'
import { visibleProjects } from './features/aria/visibility'
import { isHelmSession } from '@ari/contracts/helm'
import { AriaRow } from './features/aria/AriaRow'
import { AriaOverview } from './features/aria/AriaOverview'
import { ariaActivity, startedByAria } from './features/aria/aria-activity'
import { isEditableTarget } from './shell/editable-target'
import { anchorBelow, type MenuAnchor } from './shell/ContextMenu'
import { NewSessionLauncher } from './shell/NewSessionLauncher'
import { useSessionStart } from './shell/use-session-start'
import { captureSessionStartIntent, type SessionStartIntent } from './shell/session-start-focus'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { MachinesProvider, useMachines } from './features/machines/use-machines'
import {
  applyPatches,
  dropSettled,
  type PendingPatch,
  type SessionPatch,
} from './shell/session-patches'
import { useSessionCollapse } from './shell/use-session-collapse'
import { useSidebarView } from './shell/use-sidebar-view'
import {
  DOCK_WIDTH_BOUNDS,
  SIDEBAR_WIDTH_BOUNDS,
  useDockWidth,
  useSidebarWidth,
} from './shell/use-pane-width'
import { WelcomePanel } from './features/welcome'
import { OnboardingGate, type OnboardingWorkspaceProps } from './features/onboarding/OnboardingGate'
import './features/transcript/transcript.css'

type InspectorId =
  Exclude<SidebarNavId, 'session' | 'settings' | 'github' | 'source-control'> | 'overview'

/** Rail headings, and the accessible name of the rail itself. */
const INSPECTOR_TITLES: Record<InspectorId, string> = {
  terminal: 'Terminal',
  browser: 'Browser',
  changes: 'Changes',
  files: 'Files',
  usage: 'Usage',
  overview: 'Overview',
}

/** Aria's own tab: the sessions she is leading. Offered only beside her chat. */
const OVERVIEW_TAB: PanelTab<InspectorId> = { id: 'overview', label: 'Overview' }

/** The overview is a list, not a terminal: it never needs the dock's full width. */
const OVERVIEW_MAX_WIDTH = 400
/** Below this the overview would squeeze the chat, so it waits to be asked for. */
const OVERVIEW_MIN_WINDOW_WIDTH = 1180

/** What a docked panel can show, in tab order. */
const PANEL_TABS: readonly PanelTab<InspectorId>[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'browser', label: 'Browser' },
]

/** Where `Mod+Shift+<arrow>` sends focus, keyed by `KeyboardEvent.key`. */
const ARROW_EDGES: Record<string, PaneEdge> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'above',
  ArrowDown: 'below',
}

/** Full project registry rows; ids feed lookups, paths feed git/fs panes. */
type ProjectRow = RpcResults['project.list'][number]

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
  effort: string | null
  /** Creates the session as a lead; ordinary sessions leave this off. */
  lead?: boolean
  workspaceMode?: 'auto' | 'isolated' | 'shared'
}

function Shell({ onOpenSetup, setupCovered, onboardingOutcome }: OnboardingWorkspaceProps) {
  const { machines, local, inventoryReady, refreshInventory } = useMachines()
  const reducedMotion = useReducedMotionConfig()
  const engineSettings = useEngineSettings()
  const ariaEnabled = engineSettings.settings?.experimental.ariaEnabled === true
  const ariaEnabledRef = useRef(ariaEnabled)
  ariaEnabledRef.current = ariaEnabled
  const [inspector, setInspector] = useState<InspectorId | null>(null)
  // Usage and Changes get the full page — they're rooms. Files and the terminal
  // are tools, so they dock to the trailing rail beside the transcript.
  const [fullPage, setFullPage] = useState<'usage' | 'changes' | 'source-control' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceControlTab, setSourceControlTab] = useState<'changes' | 'requests'>('changes')
  const [changesContext, setChangesContext] = useState<Extract<
    AppOpenTarget,
    { view: 'changes' }
  > | null>(null)
  const [hubOpen, setHubOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance')
  const [listedSessions, setSessions] = useState<SessionSummary[]>([])
  // Sidebar changes show the moment they are clicked; the list catches up.
  const [patches, setPatches] = useState<readonly PendingPatch[]>([])
  const patchTokenRef = useRef(0)
  const sessions = useMemo(
    () =>
      applyPatches(listedSessions, patches).filter(
        (session) => ariaEnabled || !isHelmSession(session),
      ),
    [listedSessions, patches, ariaEnabled],
  )
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const navigation = useMachineProjects(projects, sessions)
  const [draftRegistry] = useState(() => {
    try {
      return { entries: readProjectDrafts(), error: null }
    } catch {
      return {
        entries: [],
        error: 'Project drafts could not be read. Inspect saved drafts before starting another.',
      }
    }
  })
  const [projectDrafts, setProjectDrafts] = useState<ProjectDraftEntry[]>(draftRegistry.entries)
  const projectDraftsRef = useRef(projectDrafts)
  projectDraftsRef.current = projectDrafts
  const [onboardingDraft, setOnboardingDraft] = useState<{
    projectId: string
    generation: number
    spaceId: string
    paneId: string
    sessionId: string | null
  } | null>(null)
  const [draftHandoff, setDraftHandoff] = useState<{
    entry: ProjectDraftEntry
    scope: SessionScope
    seed: ComposerSeed
  } | null>(null)
  const [createdSessionKeys, setCreatedSessionKeys] = useState<ReadonlySet<string>>(new Set())
  // Which session is active is now a property of the panes: it is whatever the
  // focused pane is showing, so every single-session view in the shell — the
  // workspace lookup below, Changes, the sidebar's highlighted row — follows
  // the pane the user is actually in rather than the last row they clicked.
  const layout = useSplitLayout()
  const spaceStore = useSpaces()
  const activeSessionId = activeSessionOf(layout)
  const activeSessionScope = activeSessionId ? parseSessionViewKey(activeSessionId) : null
  const remoteActive = activeSessionScope?.kind === 'remote'
  // The session whose browser page the panel shows; read when an agent navigates.
  const revealSessionRef = useRef<string | undefined>(undefined)
  revealSessionRef.current = remoteActive ? undefined : (activeSessionId ?? undefined)
  const visibleSessionIds = useMemo(() => sessionsOnScreen(layout), [layout])
  const { activityOf, attentionCountOf, acknowledge, forget } = useSessionActivity(
    visibleSessionIds,
    navigation.sessions.map((session) => session.id),
  )
  // Every list refresh is a new array; the lookup changes identity only when
  // a title does, or each refresh would re-render every memoized transcript row.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const titlesKey = navigation.sessions
    .map((session) => `${session.id}:${session.title}`)
    .join('\n')
  const sessionTitle = useCallback(
    (id: string) => navigation.sessions.find((session) => session.id === id)?.title,
    [titlesKey, navigation.sessions],
  )
  const attachReviewRange = useCallback(
    (
      path: string,
      comparisonId: string,
      range: { side: 'old' | 'new'; startLine: number; endLine: number; context: string },
    ) => {
      if (activeSessionId === null) return
      rememberReviewRange(activeSessionId, { path, comparisonId, ...range })
    },
    [activeSessionId],
  )
  const [importProjectId, setImportProjectId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * The pending "start a session" request, plus any overrides the entry point
   * wants applied to the session it creates. (Entry points still pass an
   * anchor — the launcher now opens centered, so it is carried but unused.)
   */
  const [newSessionRequest, setNewSessionRequest] = useState<{
    anchor: MenuAnchor
    overrides?: Partial<SessionDefaults>
    preferredHostId?: string
  } | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  // Where the pane area is the view on screen: settings, the gallery and the
  // full-page tools each stand in for it. Pane commands act on what the user is
  // looking at, so they are offered only while their effect can be seen.
  const panesVisible =
    !setupCovered && !settingsOpen && !hubOpen && !galleryOpen && fullPage === null
  // The tab strip rides above the pane area, so it stays visible while Usage or
  // Changes takes the area over — only the whole-window tools hide it.
  const tabsVisible = !setupCovered && !settingsOpen && !hubOpen && !galleryOpen
  const [composerFocusRequest, setComposerFocusRequest] = useState<{
    sessionId: string
    intent: SessionStartIntent
  } | null>(null)
  const startIntentsRef = useRef(new Set<SessionStartIntent>())
  const panesVisibleRef = useRef(panesVisible)
  panesVisibleRef.current = panesVisible
  const captureStartIntent = useCallback((): SessionStartIntent => {
    for (const previous of startIntentsRef.current) previous.cancel()
    const intent: SessionStartIntent = captureSessionStartIntent(
      () => {
        const current = splitLayoutSnapshot()
        return {
          spaceId: spaceStoreSnapshot().activeSpaceId,
          paneId: activePaneOf(current),
          sessionId: activeSessionOf(current),
        }
      },
      () => panesVisibleRef.current,
      () => {
        startIntentsRef.current.delete(intent)
        setComposerFocusRequest((previous) => (previous?.intent === intent ? null : previous))
      },
    )
    startIntentsRef.current.add(intent)
    return intent
  }, [])
  useEffect(() => {
    for (const intent of startIntentsRef.current) intent.validate()
  }, [layout, spaceStore.activeSpaceId, panesVisible])
  useEffect(() => {
    const intents = startIntentsRef.current
    return () => {
      for (const intent of intents) intent.cancel()
    }
  }, [])
  const [recentSpaceIds, setRecentSpaceIds] = useState<readonly string[]>([])
  const nextRecentSpaceIds = recentSpaces(
    recentSpaceIds,
    spaceStore.activeSpaceId,
    spaceStore.spaces.map((space) => space.id),
  )
  if (nextRecentSpaceIds !== recentSpaceIds) setRecentSpaceIds(nextRecentSpaceIds)
  // Sorted by id, not visit order: a keyed node React moves loses its scroll.
  const mountedSpaces = spaceStore.spaces
    .filter((space) => nextRecentSpaceIds.includes(space.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  // Settings is a dialog over the workspace; only the hub takes its place.
  const workspaceToolOpen = hubOpen
  // Where the keyboard was in the workspace, so leaving Settings or the hub
  // hands it back instead of dropping it on the page.
  const lastWorkspaceFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (workspaceToolOpen) return
    const last = lastWorkspaceFocusRef.current
    const lost = document.activeElement === null || document.activeElement === document.body
    if (lost && last?.isConnected === true) last.focus({ preventScroll: true })
  }, [workspaceToolOpen])
  const [sessionWorkspace, setSessionWorkspace] = useState<{
    id: string
    path: string | null
  } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (activeSessionId && parseSessionViewKey(activeSessionId)?.kind === 'local') {
      void rpc
        .invoke('session.workspace', { sessionId: activeSessionId })
        .then(({ path }) => {
          if (!cancelled) setSessionWorkspace({ id: activeSessionId, path })
        })
        .catch((error: unknown) => log.warn('workspace resolution failed', error))
    } else setSessionWorkspace(null)
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
  // New sessions start on the user's last pick. Without one, Ari Core is the
  // safe seed: it never depends on an installed CLI, and detection below
  // upgrades it to the first agent that is installed.
  const [lastPickAtBoot] = useState(loadLastPick)
  const [providersReady, setProvidersReady] = useState(false)
  const [defaults, setDefaults] = useState<SessionDefaults>(() => ({
    driverKind: lastPickAtBoot?.driverKind ?? 'ari-core',
    modelId: lastPickAtBoot?.modelId ?? null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    effort: lastPickAtBoot?.effort ?? null,
  }))

  /** A model or level the user chose in a composer becomes the next session's start. */
  const rememberPick = useCallback((change: Partial<LastPick>): void => {
    setDefaults((prev) => {
      const pick = nextLastPick(prev, change)
      saveLastPick(pick)
      return { ...prev, ...pick }
    })
  }, [])

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
  const [sidebarQuery, setSidebarQuery] = useState('')
  const dock = useDockWidth()
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      localStorage.setItem('ari.sidebar.open', open ? '0' : '1')
      return !open
    })
  }, [])

  // The terminal is a tool the transcript keeps working next to, so Ctrl+`
  // docks and undocks the rail instead of navigating anywhere.
  /**
   * Settings and the GitHub hub take the whole window, so anything that means
   * "take me back to my work" has to stand them down first. Without this the
   * shortcut fires, the state changes, and the user sees nothing at all.
   */
  const leaveWorkspaceTool = useCallback(() => {
    setSettingsOpen(false)
    setHubOpen(false)
  }, [])

  const toggleTerminal = useCallback(() => {
    leaveWorkspaceTool()
    setFullPage(null)
    setInspector((prev) => (prev === 'terminal' ? null : 'terminal'))
  }, [leaveWorkspaceTool])

  useEffect(() => {
    return rpc.subscribe('browser.updated', {}, (payload) => {
      const next = payload as BrowserTabState
      if (next.reveal !== true) return
      // An agent browsing in a session that is not on screen stays out of the
      // way; its page is there when the user opens that session's browser.
      if (next.id !== browserTabFor(revealSessionRef.current)) return
      leaveWorkspaceTool()
      setFullPage(null)
      setInspector('browser')
    })
  }, [leaveWorkspaceTool])

  // The titlebar has one toggle for the docked panel. It reopens on the tab
  // last used, so closing the panel and opening it again loses nothing.
  const lastPanelRef = useRef<InspectorId>('changes')
  if (inspector !== null) lastPanelRef.current = inspector

  // Switching chats must not kill a running shell; every other rail still
  // yields to the session view the way it always has.
  const clearTransientInspector = useCallback(() => {
    setInspector((prev) => (prev === 'terminal' || prev === 'browser' ? prev : null))
  }, [])

  // Visiting a session lands on it and clears its settled badge — done/error
  // sticks until the user has seen what the agent did.
  const navigationGeneration = useRef(0)
  const selectSession = useCallback(
    (id: string) => {
      if (
        !ariaEnabled &&
        listedSessions.some((session) => session.id === id && isHelmSession(session))
      )
        return
      navigationGeneration.current++
      // A session already open is shown where it is, in whichever space holds
      // it; anything else replaces what the focused pane was showing, which is
      // the tmux reading of a click in the session list.
      if (!splitLayoutActions.reveal(id)) splitLayoutActions.assign(layout.focusedPaneId, id)
      clearTransientInspector()
      leaveWorkspaceTool()
      // Selecting a chat must land on it, not leave Usage/Changes up.
      setFullPage(null)
      setChangesContext(null)
    },
    [layout, clearTransientInspector, leaveWorkspaceTool, ariaEnabled, listedSessions],
  )

  // Clicking an OS notification asks to see the session it was about.
  const selectSessionRef = useRef(selectSession)
  selectSessionRef.current = selectSession
  useEffect(
    () =>
      rpc.subscribe('app.navigate', {}, (payload) => {
        const parsed = navigateFrameSchema.safeParse(payload)
        if (!parsed.success) return
        const frame = parsed.data
        if ('settingsSection' in frame && frame.settingsSection === 'speech') {
          navigationGeneration.current += 1
          setHubOpen(false)
          setSettingsSection('speech')
          setSettingsOpen(true)
        } else if (!('kind' in frame) && 'sessionId' in frame) {
          selectSessionRef.current(frame.sessionId)
        }
      }),
    [],
  )

  const { toast } = useToast()
  // A link in the chat that could not be opened says why, where the click was.
  useEffect(() => {
    const onFailed = (event: Event): void => {
      const reason =
        event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : ''
      toast({ tone: 'danger', title: 'Couldn’t open that file', description: reason })
    }
    window.addEventListener(LINK_FAILED_EVENT, onFailed)
    return () => window.removeEventListener(LINK_FAILED_EVENT, onFailed)
  }, [toast])

  /**
   * Splits the pane the user is in — what `Mod+\`, `Mod+Shift+\` and the
   * palette's two entries all do. The model refuses a split at the ceiling
   * silently, which a chord cannot afford: nothing at all happens, so the
   * shortcut reads as broken. The refusal is announced here instead.
   */
  const splitActivePane = useCallback(
    (edge: PaneEdge) => {
      if (paneCount(layout) >= MAX_PANES) {
        toast({ tone: 'warning', title: `A layout holds at most ${String(MAX_PANES)} panes` })
        return
      }
      splitLayoutActions.split(activePaneOf(layout), edge)
    },
    [layout, toast],
  )

  /**
   * Opens a blank space and switches to it. The model refuses at the ceiling
   * silently, which a chord cannot afford, so the refusal is announced here —
   * the same treatment the pane ceiling gets above.
   */
  const createSpace = useCallback(() => {
    if (spaceStore.spaces.length >= MAX_SPACES) {
      toast({ tone: 'warning', title: `Ari holds at most ${String(MAX_SPACES)} spaces` })
      return
    }
    spaceActions.create()
  }, [spaceStore.spaces.length, toast])

  // A two-finger trackpad swipe switches tabs. Disabled with a single space,
  // where there is nowhere to go, and while a whole-window tool is up.
  useSpaceSwipe({
    enabled: tabsVisible && spaceStore.spaces.length > 1,
    onSwipe: (direction) => spaceActions.cycle(direction),
  })

  // A session that has just come on screen has been seen: it is the arrival in
  // a pane, not every later focus change, that clears the settled badge — and
  // only for the panes that had not been showing it already.
  const visibleRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const now = sessionsOnScreen(layout)
    for (const id of now) {
      if (!visibleRef.current.has(id)) acknowledge(id)
    }
    visibleRef.current = new Set(now)
  }, [layout, acknowledge])
  useEffect(() => {
    if (setupCovered) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, setupCovered])

  // Set on the first successful list, so the restored panes are never pruned
  // against the empty session state the shell starts from.
  const sessionsLoadedRef = useRef(false)
  /** Monotonic start counter for overlapping `session.list` calls. */
  const listsRef = useRef(0)
  /** Generation of the last list actually committed to the shell. */
  const appliedListRef = useRef(0)

  const reloadSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const generation = ++listsRef.current
    const next = await rpc.invoke('session.list')
    // An older success may land only if no newer success has already committed.
    if (generation < appliedListRef.current) return sessionsRef.current
    appliedListRef.current = generation
    sessionsLoadedRef.current = true
    setSessions(next)
    setPatches((prev) => dropSettled(prev, generation))
    return next
  }, [])
  const refreshSessions = useCallback((): void => {
    void reloadSessions().catch((error: unknown) => log.warn('rpc call failed', error))
  }, [reloadSessions])

  /**
   * Sends one sidebar change to the engine. The caller has already shown it;
   * a refusal takes it back and says why, an acceptance lets the next list
   * take over from it.
   */
  const confirmPatch = useCallback(
    (token: number, sessionId: string, patch: SessionPatch): Promise<void> => {
      const scope = parseSessionViewKey(sessionId)
      if (!scope) return Promise.reject(new Error('Unknown session scope.'))
      return createSessionClient(scope)
        .invoke('command.dispatch', {
          command: { type: 'session.update', sessionId: scope.sessionId, ...patch },
        })
        .then((result) => {
          if (!result.accepted) throw new Error(result.reason ?? 'The change was refused.')
          refreshSessions()
          void refreshInventory()
          const generation = listsRef.current
          setPatches((prev) =>
            prev.map((p) => (p.token === token ? { ...p, settledAt: generation } : p)),
          )
        })
        .catch((error: unknown) => {
          log.warn('session update failed', error)
          setPatches((prev) => prev.filter((p) => p.token !== token))
          toast({
            tone: 'danger',
            title: 'Couldn’t update the session',
            description: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [refreshSessions, refreshInventory, toast],
  )
  const destroyScopedSession = useCallback(
    async (key: string) => {
      const scope = parseSessionViewKey(key)
      if (!scope) throw new Error('Unknown session scope.')
      await createSessionClient(scope).invoke('session.destroy', { sessionId: scope.sessionId })
      setCreatedSessionKeys((old) => new Set([...old].filter((entry) => entry !== key)))
      void refreshInventory()
    },
    [refreshInventory],
  )

  /** Shows `patch` on each session at once and confirms them one by one. */
  const patchSessions = useCallback(
    (ids: readonly string[], patch: SessionPatch): void => {
      const pending = ids.map((sessionId) => ({ token: ++patchTokenRef.current, sessionId, patch }))
      setPatches((prev) => [...prev, ...pending])
      void (async () => {
        for (const p of pending) await confirmPatch(p.token, p.sessionId, p.patch)
      })()
    },
    [confirmPatch],
  )

  // A pane remembers what it was showing across launches. A session that is
  // gone by the time the list arrives blanks its pane rather than leaving the
  // shell pointed at something that no longer exists.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return
    const known = new Set(navigation.sessions.map((session) => session.id))
    for (const key of createdSessionKeys) {
      const scope = parseSessionViewKey(key)
      if (
        scope?.kind === 'local' ||
        (scope?.kind === 'remote' &&
          machines.some(
            (machine) => machine.id === scope.machineId && machine.status !== 'revoked',
          ))
      )
        known.add(key)
    }
    // Offline hosts keep their scoped pane refs until explicit removal/revocation.
    for (const space of spaceStore.spaces)
      for (const id of sessionsOnScreen(space.layout)) {
        const scope = parseSessionViewKey(id)
        if (
          scope?.kind === 'remote' &&
          machines.some(
            (machine) =>
              machine.id === scope.machineId &&
              machine.status !== 'revoked' &&
              machine.status !== 'unpaired',
          )
        )
          known.add(id)
      }
    splitLayoutActions.prune(known)
    keepAliveActions.keepOnly(known)
  }, [navigation.sessions, machines, spaceStore.spaces, createdSessionKeys])

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
          event.type !== 'session.provider.switched' &&
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
      .then((list) => setProjects(visibleProjects(list)))
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  // New sessions start in the mode Settings → Permissions names; without this
  // the seed above never left `ask`, whatever the setting said.
  const openSourceControl = useCallback(
    (
      tab: 'changes' | 'requests' = 'changes',
      context: Extract<AppOpenTarget, { view: 'changes' }> | null = null,
    ): void => {
      navigationGeneration.current += 1
      setChangesContext(context)
      setSourceControlTab(tab)
      setHubOpen(false)
      setSettingsOpen(false)
      if (engineSettings.settings?.sourceControl.diffOpenMode === 'sidebar') {
        setFullPage(null)
        setInspector('changes')
      } else {
        setInspector(null)
        setFullPage('changes')
      }
    },
    [engineSettings.settings?.sourceControl.diffOpenMode],
  )
  const defaultPermissionMode = engineSettings.settings?.sessions.defaultPermissionMode
  const ariaStatus = useMemo(
    () => ariaActivity(sessions, activityOf, attentionCountOf),
    [sessions, activityOf, attentionCountOf],
  )
  const ariaStartedIds = useMemo(
    () => new Set(ariaEnabled ? sessions.filter(startedByAria).map((session) => session.id) : []),
    [sessions, ariaEnabled],
  )
  const openAria = useCallback(
    (newChat = false): void => {
      if (!ariaEnabled) return
      // The pinned row is navigation, just like any other known session.
      // Discovery scans every saved journal and must not hold up switching
      // back to the Aria chat the shell has already listed.
      const current = sessions
        .filter((session) => isHelmSession(session) && !session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (!newChat && current) {
        selectSessionRef.current(current.id)
        return
      }
      const generation = ++navigationGeneration.current
      const origin = spaceStoreSnapshot().activeSpaceId
      const originLayout = splitLayoutSnapshot()
      const request = newChat ? rpc.invoke('aria.newChat') : rpc.invoke('aria.open', defaults)
      void request
        .then(async ({ sessionId }) => {
          if (!ariaEnabledRef.current) return
          if (newChat)
            for (const session of sessions)
              if (isHelmSession(session) && !session.archived) forget(session.id)
          await reloadSessions()
          const layout = splitLayoutSnapshot()
          if (
            generation !== navigationGeneration.current ||
            origin !== spaceStoreSnapshot().activeSpaceId ||
            originLayout !== layout
          )
            return
          selectSessionRef.current(sessionId)
        })
        .catch((error: unknown) => {
          if (!ariaEnabledRef.current) return
          log.warn('Aria could not open', error)
          toast({
            tone: 'danger',
            title: 'Could not open Aria',
            description: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [defaults, reloadSessions, toast, sessions, forget, ariaEnabled],
  )
  const openAriaRef = useRef(openAria)
  openAriaRef.current = openAria
  const landed = useRef(false)
  useEffect(() => {
    if (
      landed.current ||
      setupCovered ||
      !sessionsLoadedRef.current ||
      !providersReady ||
      engineSettings.settings === null
    )
      return
    if (onboardingOutcome?.sessionId != null || onboardingOutcome?.projectId != null) {
      landed.current = true
      return
    }
    if (activeSessionId !== null && !sessions.some((session) => session.id === activeSessionId))
      return
    landed.current = true
    if (activeSessionId === null && leaves(layout.root).every(isBlankLeaf)) openAriaRef.current()
  }, [
    sessions,
    setupCovered,
    activeSessionId,
    layout,
    providersReady,
    engineSettings.settings,
    onboardingOutcome?.sessionId,
    onboardingOutcome?.projectId,
  ])
  useEffect(() => {
    if (defaultPermissionMode === undefined) return
    setDefaults((prev) =>
      prev.permissionMode === defaultPermissionMode
        ? prev
        : { ...prev, permissionMode: defaultPermissionMode },
    )
  }, [defaultPermissionMode])

  // First available CLI becomes the default driver at boot; when none is
  // installed, sessions fall back to Ari Core (endpoint-powered).
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        const installed = detections.find((d) => d.binaryPath !== null && d.kind !== 'ari-core')
        if (installed) {
          setDefaults((prev) => {
            // A remembered agent that is still installed stays; one that was
            // uninstalled since, or the bare Ari Core seed, gives way.
            const usable =
              prev.driverKind === 'ari-core'
                ? lastPickAtBoot?.driverKind === 'ari-core'
                : detections.some((d) => d.kind === prev.driverKind && d.binaryPath !== null)
            return usable
              ? prev
              : { ...prev, driverKind: installed.kind as DriverKind, modelId: null, effort: null }
          })
        }
      })
      .catch((error: unknown) => log.warn('rpc call failed', error))
      .finally(() => setProvidersReady(true))
  }, [])

  const commands = useCommands({
    onOpenAria: ariaEnabled
      ? () => {
          openAria()
          setPaletteOpen(false)
        }
      : undefined,
    onNavigate: (view) => {
      if (view === 'settings') {
        setHubOpen(false)
        setSettingsOpen(true)
      } else if (view === 'github') {
        setSettingsOpen(false)
        setHubOpen(true)
      } else if (view === 'sessions') {
        setHubOpen(false)
        clearTransientInspector()
      } else if (view === 'terminal') {
        setHubOpen(false)
        setSettingsOpen(false)
        setFullPage(null)
        setInspector('terminal')
      } else if (view === 'browser') {
        setHubOpen(false)
        setSettingsOpen(false)
        setFullPage(null)
        setInspector('browser')
      } else if (view === 'changes' || view === 'source-control') {
        openSourceControl()
      } else {
        setHubOpen(false)
        setSettingsOpen(false)
        setInspector(view)
      }
      setPaletteOpen(false)
    },
    onOpenGallery: () => {
      leaveWorkspaceTool()
      setGalleryOpen(true)
      setPaletteOpen(false)
    },
    onOpenSearch: () => {
      if (remoteActive) {
        toast({ tone: 'info', title: 'Content search is unavailable on this host.' })
        return
      }
      leaveWorkspaceTool()
      setSearchOpen(true)
      setPaletteOpen(false)
    },
    panes: panesVisible
      ? {
          split: splitActivePane,
          close: () => splitLayoutActions.close(activePaneOf(layout)),
          toggleZoom: () => splitLayoutActions.toggleZoom(activePaneOf(layout)),
          single: paneCount(layout) === 1,
        }
      : undefined,
    spaces: {
      spaces: spaceStore.spaces.map((space) => ({ id: space.id, name: space.name })),
      atCeiling: spaceStore.spaces.length >= MAX_SPACES,
      single: spaceStore.spaces.length <= 1,
      create: createSpace,
      close: () => spaceActions.close(spaceStore.activeSpaceId),
      next: () => spaceActions.cycle(1),
      previous: () => spaceActions.cycle(-1),
      select: spaceActions.select,
    },
  })

  // Sidebar-visible order — the same sequence Mod+1..9 and Ctrl+Tab traverse.
  // Grouped by the open projects in the Projects view; root cards, pinned
  // then newest, in the Sessions view. Either way keyboard order matches
  // what is rendered, and child agents are not their own stops.
  const openProjects = useMemo(() => projects.filter((p) => p.open), [projects])
  const { collapsed: collapsedChildren } = useSessionCollapse()
  const { view: sidebarView } = useSidebarView()
  const navOrder = useMemo(
    () =>
      sidebarView === 'sessions'
        ? sessionsViewOrder(navigation.sessions)
        : sidebarOrder(navigation.sessions, navigation.sidebarProjects),
    [navigation.sessions, navigation.sidebarProjects, sidebarView, collapsedChildren],
  )

  const refreshProjects = useCallback((): void => {
    void rpc
      .invoke('project.list')
      .then((list) => setProjects(visibleProjects(list)))
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  useEffect(() => rpc.subscribe('projects.changed', {}, refreshProjects), [refreshProjects])

  useEffect(() => {
    if (onboardingOutcome === null) return
    let cancelled = false
    if (onboardingOutcome.driverKind !== null)
      rememberPick({ driverKind: onboardingOutcome.driverKind, modelId: null, effort: null })
    if (onboardingOutcome.projectId !== null) {
      const owner = splitLayoutSnapshot()
      setOnboardingDraft({
        projectId: onboardingOutcome.projectId,
        generation: navigationGeneration.current,
        spaceId: spaceStoreSnapshot().activeSpaceId,
        paneId: activePaneOf(owner),
        sessionId: activeSessionOf(owner),
      })
    } else setOnboardingDraft(null)
    refreshProjects()
    void refreshInventory()
    void reloadSessions()
      .then(() => {
        if (!cancelled && onboardingOutcome.sessionId !== null)
          selectSessionRef.current(onboardingOutcome.sessionId)
      })
      .catch((error: unknown) => {
        log.warn('workspace refresh after setup failed', error)
        toast({
          tone: 'warning',
          title: 'Setup is saved',
          description: 'Reopen Ari if your new projects or session have not appeared yet.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [onboardingOutcome, reloadSessions, refreshProjects, refreshInventory, rememberPick, toast])

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
    if (setupCovered) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
      if (ariaEnabled && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '0') {
        e.preventDefault()
        openAriaRef.current()
        return
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
      // Spaces: Ctrl+PageUp/PageDown cycle tabs, Ctrl+Alt+T/W create and close,
      // and Ctrl+Alt+1..9 jump straight to a tab. These are checked before the
      // session jumps below, which share the number row across the whole app.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        if (tabsVisible && !paletteOpen && !searchOpen) {
          e.preventDefault()
          spaceActions.cycle(e.key === 'PageDown' ? 1 : -1)
        }
      }
      // Matched on the physical key as well as the character: on macOS, Option
      // rewrites `key` (Option+T is "†"), so `key` alone never matches there.
      const altDigit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null)
      if ((e.ctrlKey || e.metaKey) && e.altKey && altDigit !== null) {
        if (tabsVisible && !paletteOpen && !searchOpen) {
          e.preventDefault()
          spaceActions.selectAt(Number(altDigit) - 1)
        }
      }
      const altLetter = (letter: string): boolean =>
        e.code === `Key${letter.toUpperCase()}` || e.key.toLowerCase() === letter
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && altLetter('t')) {
        if (tabsVisible && !paletteOpen && !searchOpen) {
          e.preventDefault()
          createSpace()
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && altLetter('w')) {
        // The last space cannot be closed anywhere else in the UI; here it
        // would silently reset the whole pane layout.
        if (tabsVisible && !paletteOpen && !searchOpen && spaceStore.spaces.length > 1) {
          e.preventDefault()
          spaceActions.close(spaceStore.activeSpaceId)
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[1-9]$/.test(e.key)) {
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '\\' || e.key === '|')) {
        // Shift turns the key itself into `|` on most layouts, so the chord is
        // read from either — and `shiftKey` says which of the two it is.
        // A pane chord never fires over a text field, an open overlay, or a view
        // that has taken the pane area's place: the composer's own keys, the
        // palette's, and the settings screen's all come first.
        if (!paletteOpen && !searchOpen && panesVisible && !isEditableTarget(e.target)) {
          e.preventDefault()
          splitActivePane(e.shiftKey ? 'below' : 'right')
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const edge = ARROW_EDGES[e.key]
        if (
          edge !== undefined &&
          !paletteOpen &&
          !searchOpen &&
          panesVisible &&
          !isEditableTarget(e.target)
        ) {
          // Focus moves between panes the way the arrow points; the edge of the
          // layout is the end of the road, so nothing happens there.
          const neighbour = focusNeighbour(layout, activePaneOf(layout), edge)
          if (neighbour !== null) {
            e.preventDefault()
            splitLayoutActions.focus(neighbour)
          }
        }
      }
      if (e.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false)
          return
        }
        if (settingsOpen) setSettingsOpen(false)
        if (hubOpen) setHubOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    setupCovered,
    ariaEnabled,
    paletteOpen,
    settingsOpen,
    hubOpen,
    panesVisible,
    tabsVisible,
    navOrder,
    activeSessionId,
    spaceStore.activeSpaceId,
    toggleTerminal,
    selectSession,
    splitActivePane,
    createSpace,
    layout,
  ])

  const sessionStart = useSessionStart({
    defaults,
    sessions,
    captureIntent: captureStartIntent,
    refreshProjects,
    refreshSessions,
    checkSessions: async () => {
      await reloadSessions()
    },
    onStarted: (sessionId, effective, intent) => {
      if (effective !== null) writeDefaults(sessionId, effective)
      if (!intent.select(sessionId)) {
        intent.dispose()
        return
      }
      splitLayoutActions.assign(intent.scope.paneId, sessionId)
      if (intent.wantsFocus) {
        clearTransientInspector()
        setComposerFocusRequest({ sessionId, intent })
      } else intent.dispose()
    },
  })
  const openProjectDraft = useCallback(
    (group: RepositoryGroup, lead = false, initialHostId?: string) => {
      if (draftRegistry.error) {
        toast({ tone: 'warning', title: draftRegistry.error })
        return
      }
      const currentSpace = spaceStoreSnapshot().activeSpaceId
      const paneId = activePaneOf(splitLayoutSnapshot())
      const existing = projectDrafts.find(
        (entry) =>
          entry.groupId === group.id &&
          entry.spaceId === currentSpace &&
          localStorage.getItem(`ari.machines.projectDraft.attempt.v1:${entry.id}`) !== null,
      )
      const entry: ProjectDraftEntry = existing
        ? { ...existing, paneId }
        : {
            id: crypto.randomUUID(),
            groupId: group.id,
            group,
            spaceId: currentSpace,
            paneId,
            initialHostId,
            lead,
          }
      const next = [...projectDrafts.filter((draft) => draft.id !== entry.id), entry]
      try {
        writeProjectDrafts(next)
      } catch {
        toast({
          tone: 'warning',
          title: 'Save project drafts before starting. Free browser storage and try again.',
        })
        return
      }
      setProjectDrafts(next)
      splitLayoutActions.clear(paneId)
      setNewSessionRequest(null)
      leaveWorkspaceTool()
      setFullPage(null)
      setInspector(null)
    },
    [projectDrafts, draftRegistry.error, toast, leaveWorkspaceTool],
  )
  useEffect(() => {
    if (onboardingDraft === null) return
    if (
      onboardingDraft.generation !== navigationGeneration.current ||
      onboardingDraft.spaceId !== spaceStore.activeSpaceId ||
      onboardingDraft.paneId !== activePaneOf(layout) ||
      onboardingDraft.sessionId !== activeSessionOf(layout)
    ) {
      setOnboardingDraft(null)
      return
    }
    // project.list can win the parallel refresh before repository identity.
    // Freeze the draft group only after the selected local checkout is catalogued.
    if (
      !inventoryReady ||
      !local?.catalog.projects.some((project) => project.id === onboardingDraft.projectId)
    )
      return
    const group = navigation.groups.find((entry) =>
      entry.checkouts.some(
        (checkout) => checkout.local && checkout.projectId === onboardingDraft.projectId,
      ),
    )
    if (!group) return
    setOnboardingDraft(null)
    openProjectDraft(group, false, 'local')
  }, [
    onboardingDraft,
    navigation.groups,
    openProjectDraft,
    spaceStore.activeSpaceId,
    layout,
    inventoryReady,
    local,
  ])
  const createSession = useCallback(
    (projectId: string, overrides?: Partial<SessionDefaults>) => {
      const group = navigation.groups.find(
        (entry) =>
          entry.id === projectId ||
          entry.checkouts.some((checkout) => checkout.local && checkout.projectId === projectId),
      )
      if (group) openProjectDraft(group, overrides?.lead, newSessionRequest?.preferredHostId)
      else toast({ tone: 'warning', title: 'Refresh projects before opening this draft.' })
    },
    [navigation.groups, openProjectDraft, newSessionRequest?.preferredHostId, toast],
  )

  /**
   * Single door for every "new session" affordance. A session always belongs
   * to a project, so with none registered the folder picker comes first and
   * the session is created in whatever the user picks. Otherwise the rail
   * asks which project to run in — the answer is no longer implied, since
   * every session now has a real one.
   */
  const beginNewSession = useCallback(
    (
      anchor: MenuAnchor,
      overrides?: Partial<SessionDefaults>,
      intent?: SessionStartIntent,
    ): void => {
      if (!sessionStart.canStart() || (intent && !intent.isCurrent())) {
        intent?.dispose()
        return
      }
      if (overrides) setDefaults((previous) => ({ ...previous, ...overrides }))
      intent?.dispose() // The chooser owns the next explicit pick and its focus.
      setNewSessionRequest({ anchor, overrides })
    },
    [sessionStart.canStart],
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

  const addProjectAndStart = useCallback(
    (overrides?: Partial<SessionDefaults>): void => {
      setNewSessionRequest(null)
      void openProjectViaPicker()
        .then((project) => {
          if (!project) return
          refreshProjects()
          void refreshInventory()
          const group = groupRepositories([
            {
              hostId: 'local',
              hostName: 'This PC',
              projectId: project.id,
              name: project.name,
              checkoutLabel: project.path,
              local: true,
              repository: null,
            },
          ])[0]!
          openProjectDraft(group, overrides?.lead, 'local')
        })
        .catch((error) =>
          toast({
            tone: 'danger',
            title: 'Could not open the project',
            description: String(error),
          }),
        )
    },
    [refreshProjects, refreshInventory, openProjectDraft, toast],
  )

  const selectWorkspaceTool = useCallback(
    (id: SidebarNavId | 'overview'): void => {
      if (remoteActive && (id === 'browser' || id === 'usage' || id === 'github')) {
        toast({ tone: 'info', title: 'This tool is unavailable for the selected machine.' })
        return
      }
      if (id === 'settings') {
        setSettingsOpen(true)
        setHubOpen(false)
        setFullPage(null)
        setInspector(null)
        return
      }
      if (id === 'github') {
        setHubOpen(true)
        setSettingsOpen(false)
        setFullPage(null)
        setInspector(null)
        return
      }
      setSettingsOpen(false)
      setHubOpen(false)
      if (id === 'session') {
        setInspector(null)
        setFullPage(null)
        return
      }
      if (id === 'changes' || id === 'source-control') {
        openSourceControl()
        return
      }
      if (id === 'usage') {
        setInspector(null)
        setFullPage((prev) => (prev === id ? null : id))
        return
      }
      setFullPage(null)
      setInspector((prev) => (prev === id ? null : id))
    },
    [openSourceControl, remoteActive, toast],
  )

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const ariaActive = activeSession !== undefined && isHelmSession(activeSession)
  // Aria's overview is part of her page: it opens beside her chat when there
  // is room and nothing else is docked, and leaves with her. Once the user
  // closes it, it stays closed until they ask for it again.
  const overviewDismissedRef = useRef(false)
  useEffect(() => {
    if (!ariaActive) {
      setInspector((current) => (current === 'overview' ? null : current))
      return
    }
    if (overviewDismissedRef.current || window.innerWidth < OVERVIEW_MIN_WINDOW_WIDTH) return
    setInspector((current) => current ?? 'overview')
  }, [ariaActive])
  // The usage chip names the driver of whichever session is active, which in a
  // split is the focused pane's — not the shell's seed for new sessions.
  const activeDriverKind =
    activeSessionId === null ? defaults.driverKind : defaultsFor(activeSessionId).driverKind
  // The explorer roots at the active session's project, falling back to the
  // first registered project so the pane is never dead on arrival.
  const activeProjectPath = remoteActive
    ? '.'
    : activeSessionId !== null
      ? sessionWorkspace?.id === activeSessionId
        ? sessionWorkspace.path
        : null
      : (projects.find((p) => p.id === activeSession?.projectId)?.path ?? projects[0]?.path ?? null)
  // Capability scope matching activeProjectPath above: a session workspace
  // resolves by session id, a project folder by project id. The explorer
  // sends this scope plus relative paths only — absolute paths never cross
  // IPC for fs.* calls.
  // Memoized on its ids: the explorer and content search reload whenever the
  // scope changes identity, so a fresh object per render would reset them on
  // every shell update (the file tree kept re-listing and closed open files).
  const activeScopeProjectId = activeSession?.projectId ?? projects[0]?.id
  const activeWorkspaceReady = activeSessionId !== null && sessionWorkspace?.id === activeSessionId
  // Keyed on ids, so the file explorer does not reload on every render.
  const remoteSessionId = remoteActive ? activeSessionScope?.sessionId : undefined
  const activeScope = useMemo(
    () =>
      remoteSessionId !== undefined
        ? { sessionId: remoteSessionId }
        : activeSessionId !== null
          ? activeWorkspaceReady
            ? { sessionId: activeSessionId }
            : null
          : activeScopeProjectId !== undefined
            ? { projectId: activeScopeProjectId }
            : null,
    [remoteSessionId, activeSessionId, activeWorkspaceReady, activeScopeProjectId],
  )
  const changesSessionId = changesContext ? (changesContext.sessionId ?? null) : activeSessionId
  const changesClientScope = changesContext
    ? changesContext.sessionId
      ? parseSessionViewKey(changesContext.sessionId)
      : null
    : activeSessionScope
  const changesWireSessionId = changesClientScope?.sessionId ?? changesSessionId
  const changesProjectId = changesContext?.projectId ?? activeSession?.projectId ?? null
  const changesScope = changesContext
    ? changesContext.sessionId
      ? changesClientScope
        ? { sessionId: changesClientScope.sessionId }
        : null
      : { projectId: changesContext.projectId }
    : activeScope
  const sourceControlScope =
    inspector === 'changes' || fullPage === 'changes' || fullPage === 'source-control'
      ? changesScope
      : activeScope
  useAppNavigation({
    userIntent: () => {
      navigationGeneration.current++
    },
    intent: () =>
      JSON.stringify([
        layout,
        spaceStore.activeSpaceId,
        settingsOpen,
        hubOpen,
        galleryOpen,
        fullPage,
        inspector,
        setupCovered,
        navigationGeneration.current,
      ]),
    prepare: async (target) => {
      if (setupCovered) return false
      if (target.view === 'settings') return true
      const next = await reloadSessions()
      if (target.view === 'session' || target.view === 'aria' || target.sessionId !== undefined) {
        const session = next.find((session) => session.id === target.sessionId && !session.archived)
        if (
          !session ||
          (!ariaEnabled && isHelmSession(session)) ||
          (target.view === 'aria' && !isHelmSession(session)) ||
          (target.view === 'changes' && session.projectId !== target.projectId)
        )
          return false
      }
      if (target.view === 'changes') {
        const list = await rpc.invoke('project.list')
        const project = list.find((project) => project.id === target.projectId)
        return project !== undefined && project.status === 'ok'
      }
      return true
    },
    apply: (target) => {
      navigationGeneration.current += 1
      setGalleryOpen(false)
      if (target.view === 'session' || target.view === 'aria')
        selectSessionRef.current(target.sessionId)
      else if (target.view === 'settings') {
        setHubOpen(false)
        setSettingsOpen(true)
      } else openSourceControl('changes', target)
    },
    observe: (target) => {
      if (setupCovered || galleryOpen || hubOpen) return undefined
      if (target.view === 'session' || target.view === 'aria')
        return !settingsOpen &&
          fullPage === null &&
          activeSessionId === target.sessionId &&
          sessions.some((session) => session.id === target.sessionId && !session.archived)
          ? { target, mode: 'chat' }
          : undefined
      if (target.view === 'settings') return settingsOpen ? { target, mode: 'settings' } : undefined
      if (settingsOpen || JSON.stringify(changesContext) !== JSON.stringify(target))
        return undefined
      return fullPage === 'changes'
        ? { target, mode: 'page' }
        : inspector === 'changes'
          ? { target, mode: 'sidebar' }
          : undefined
    },
  })
  // Where a shell can actually run — the rule and its precedence live in
  // `shellRootFor`, which is unit-tested. A null answer is what makes the rail
  // offer a project instead of a spawn the main process would refuse.
  const shellRoot = useMemo(
    () => (remoteActive ? null : shellRootFor(activeSession, activeProjectPath, projects)),
    [remoteActive, activeSession, activeProjectPath, projects],
  )
  const localProjectIdFor = (groupId: string): string | null => {
    const group = navigation.groups.find((entry) => entry.id === groupId)
    if (!group) return projects.some((project) => project.id === groupId) ? groupId : null
    const local = group.checkouts.filter((checkout) => checkout.local)
    return local.length === 1 ? local[0]!.projectId : null
  }
  const terminalDock = useSyncExternalStore(subscribeTerminalDock, terminalDockState)
  const finishProjectDraft = (entry: ProjectDraftEntry, scope: SessionScope) => {
    const key = sessionViewKey(scope)
    setCreatedSessionKeys((old) => new Set(old).add(key))
    const owner = projectDraftsRef.current.find((draft) => draft.id === entry.id)
    const stillOwnsPane =
      owner?.paneId === entry.paneId &&
      owner.spaceId === entry.spaceId &&
      !projectDraftsRef.current.some(
        (draft) =>
          draft.id !== entry.id && draft.spaceId === entry.spaceId && draft.paneId === entry.paneId,
      )
    spaceActions.update((store) => ({
      ...store,
      spaces: store.spaces.map((space) =>
        stillOwnsPane &&
        space.id === entry.spaceId &&
        leaves(space.layout.root).find((pane) => pane.paneId === entry.paneId)?.sessionId === null
          ? { ...space, layout: assignSession(space.layout, entry.paneId, key) }
          : space,
      ),
    }))
    const next = projectDraftsRef.current.filter((draft) => draft.id !== entry.id)
    try {
      writeProjectDrafts(next)
      setProjectDrafts(next)
    } catch {
      /* Retain the original draft metadata if storage refused. */
    }
    deleteSessionDraftText(`project-draft:${entry.id}`)
    deleteSessionDraftIntent(`project-draft:${entry.id}`)
    refreshSessions()
    void refreshInventory()
  }
  const renderProjectDraft = (spaceId: string, paneId: string) => {
    const entry = [...projectDrafts]
      .reverse()
      .find((draft) => draft.spaceId === spaceId && draft.paneId === paneId)
    if (!entry) return undefined
    return (
      <ProjectDraftPane
        key={entry.id}
        entry={entry}
        projects={projects}
        defaults={defaults}
        createLocal={sessionStart.createDraft}
        onCreated={(scope, seed) => {
          if (seed) setDraftHandoff({ entry, scope, seed })
          else finishProjectDraft(entry, scope)
        }}
        onClose={() => {
          const next = projectDrafts.map((draft) =>
            draft.id === entry.id ? { ...draft, paneId: `parked:${draft.id}` } : draft,
          )
          try {
            writeProjectDrafts(next)
            setProjectDrafts(next)
          } catch {
            toast({
              tone: 'warning',
              title: 'The draft could not be parked. Its content remains here.',
            })
          }
        }}
      />
    )
  }
  // Every space's panes, not only the one on screen: a terminal hosted in
  // another space must not also appear as a rail tab that can close it.
  const paneTerminalIds = useMemo(
    () => new Set(spaceStore.spaces.flatMap((space) => terminalIdsInPanes(space.layout))),
    [spaceStore.spaces],
  )
  const canOpenTerminalInPane = (paneId: string): boolean => {
    const pane = spaceStore.spaces
      .flatMap((space) => leaves(space.layout.root))
      .find((leaf) => leaf.paneId === paneId)
    if (!pane?.sessionId) return false
    const scope = parseSessionViewKey(pane.sessionId)
    return (
      scope !== null &&
      (scope.kind === 'local' ||
        machines.find((machine) => machine.id === scope.machineId)?.allowTerminal === true) &&
      createSessionClient(scope).capabilityReason('terminal.create') === null
    )
  }
  const openTerminalInPane = useCallback(
    (paneId: string) => {
      const origin = spaceStoreSnapshot().spaces.find((space) =>
        leaves(space.layout.root).some((pane) => pane.paneId === paneId),
      )
      const key =
        origin && leaves(origin.layout.root).find((pane) => pane.paneId === paneId)?.sessionId
      const scope = key ? parseSessionViewKey(key) : null
      if (!origin || !scope) return
      const client = createSessionClient(scope)
      const reason = client.capabilityReason('terminal.create')
      if (reason) {
        toast({ tone: 'info', title: reason })
        return
      }
      void (async () => {
        try {
          const cwd =
            scope.kind === 'remote'
              ? '.'
              : (await client.invoke('session.workspace', { sessionId: scope.sessionId })).path
          if (!cwd || client.capabilityReason('terminal.create')) return
          // A late workspace result cannot replace a different pane or follow focus to another host.
          const current = spaceStoreSnapshot().spaces.find((space) => space.id === origin.id)
          if (
            !current ||
            leaves(current.layout.root).find((pane) => pane.paneId === paneId)?.sessionId !== key
          )
            return
          const id = openTerminalTab({
            title: 'Ari Terminal',
            cwd,
            ...(scope.kind === 'remote' ? { owner: scope } : {}),
          })
          spaceActions.update((store) => ({
            ...store,
            spaces: store.spaces.map((space) =>
              space.id === origin.id
                ? { ...space, layout: assignTerminal(space.layout, paneId, id) }
                : space,
            ),
          }))
        } catch (error) {
          toast({
            tone: 'danger',
            title: 'Could not open the terminal',
            description: String(error),
          })
        }
      })()
    },
    [toast],
  )

  if (galleryOpen) {
    return (
      <div className="ari-wallpaper-pane flex h-full flex-col bg-surface-0">
        <header
          className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center gap-2 pl-4 text-sm"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <span className="text-fg-subtle">Ari</span>
          <span className="text-fg-subtle opacity-50">/</span>
          <span className="font-medium text-fg">Component gallery</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setGalleryOpen(false)}
            className={`${outlineButton} mr-[150px]`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            Back to workspace
          </button>
        </header>
        <div className="ari-stage mx-[var(--ari-frame-gap)] mb-[var(--ari-frame-gap)] min-h-0 flex-1">
          <GalleryView />
        </div>
      </div>
    )
  }

  const activeTool = settingsOpen ? 'settings' : hubOpen ? 'github' : (fullPage ?? inspector)

  return (
    <div className="ari-wallpaper-pane flex h-full flex-col bg-surface-0">
      <ScopedTitlebar
        scope={
          inspector === 'changes' || fullPage === 'changes' || fullPage === 'source-control'
            ? changesClientScope
            : activeSessionScope
        }
        gitScope={sourceControlScope}
        hideGit={workspaceToolOpen}
        onReview={() => openSourceControl('changes')}
        onRequests={() => openSourceControl('requests')}
        panelOpen={inspector !== null}
        onTogglePanel={() => {
          if (inspector !== null) {
            // Closing her overview is a choice; it stays closed.
            if (inspector === 'overview') overviewDismissedRef.current = true
            setInspector(null)
            return
          }
          const last = lastPanelRef.current
          const next: InspectorId =
            last === 'overview'
              ? ariaActive
                ? 'overview'
                : 'changes'
              : last === 'browser' && remoteActive
                ? 'changes'
                : last
          leaveWorkspaceTool()
          setFullPage(null)
          if (next === 'changes') setSourceControlTab('changes')
          setInspector(next)
        }}
        leading={
          sidebarOpen && !workspaceToolOpen ? (
            <SidebarHeader
              onSearch={() => sidebarSearchRef.current?.focus()}
              onCollapse={toggleSidebar}
            />
          ) : undefined
        }
        leadingWidth={sidebar.width}
        usage={
          remoteActive ? undefined : (
            <ProviderUsagePill sessionId={activeSessionId} kind={activeDriverKind} />
          )
        }
        onExpandSidebar={sidebarOpen || workspaceToolOpen ? undefined : toggleSidebar}
        projectLabel={
          // Aria's page names her itself; a workspace tool fills the window.
          ariaActive || workspaceToolOpen
            ? undefined
            : navigation.sidebarProjects.find(
                (group) =>
                  group.id ===
                  navigation.sessions.find((session) => session.id === activeSessionId)?.projectId,
              )?.name
        }
      />
      {/* Settings opens as a dialog over the workspace, which stays visible
          and mounted underneath. */}
      <SettingsDialog
        // Setup covers the whole window; settings waits underneath until it is done.
        open={settingsOpen && !setupCovered}
        onOpenChange={setSettingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        onOpenMachine={(machineId) => {
          setSettingsOpen(false)
          setHubOpen(false)
          setNewSessionRequest({ anchor: { x: 24, y: 88 }, preferredHostId: machineId })
        }}
        onOpenSetup={onOpenSetup}
        workspacePath={sessionWorkspace?.path ?? null}
        onOpenTerminal={() => {
          setSettingsOpen(false)
          setFullPage(null)
          setInspector('terminal')
        }}
      />
      {/* The hub covers the workspace rather than replacing it: the sidebar,
          sessions and terminals stay mounted underneath. */}
      {hubOpen ? (
        <HubWorkspace
          projects={projects}
          initialProjectId={activeSession?.projectId ?? projects[0]?.id ?? null}
          onBack={() => setHubOpen(false)}
        />
      ) : null}
      <div
        className={`${workspaceToolOpen ? 'hidden' : 'flex'} min-h-0 flex-1`}
        hidden={workspaceToolOpen}
        inert={workspaceToolOpen}
        onFocusCapture={(event) => {
          lastWorkspaceFocusRef.current = event.target
        }}
      >
        <AnimatePresence initial={false}>
          {sidebarOpen ? (
            <motion.aside
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: sidebar.width, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={sidebar.dragging || reducedMotion ? { duration: 0 } : transitions.sidebar}
              className="ari-sidebar-motion ari-workspace-sidebar flex shrink-0 flex-col overflow-hidden pt-1"
              style={{ '--ari-sidebar-motion-width': `${sidebar.width}px` } as React.CSSProperties}
            >
              {ariaEnabled && (
                <AriaRow
                  selected={isHelmSession(activeSession)}
                  activity={ariaStatus}
                  onOpen={() => openAria()}
                  onNewChat={() => openAria(true)}
                />
              )}
              <SessionsUnderProjects
                sessions={navigation.sessions}
                projects={navigation.sidebarProjects}
                knownProjectNames={navigation.sidebarProjects}
                searchInputRef={sidebarSearchRef}
                searchQuery={sidebarQuery}
                onSearchQueryChange={setSidebarQuery}
                onNewSession={beginNewSession}
                onOpenProject={openProjectViaDialog}
                onNewSessionInProject={(projectId) => createSession(projectId)}
                onImportSessions={(groupId) => {
                  const id = localProjectIdFor(groupId)
                  if (id) setImportProjectId(id)
                }}
                onRevealProject={(groupId) => {
                  const projectId = localProjectIdFor(groupId)
                  if (!projectId) return
                  const path = projects.find((p) => p.id === projectId)?.path
                  if (path === undefined) return
                  void rpc
                    .invoke('shell.revealPath', { path })
                    .catch((error: unknown) => log.warn('rpc call failed', error))
                }}
                onCloseProject={(groupId) => {
                  const projectId = localProjectIdFor(groupId)
                  if (!projectId) return
                  void rpc
                    .invoke('project.close', { id: projectId })
                    .then(refreshProjects)
                    .catch((error: unknown) => log.warn('rpc call failed', error))
                }}
                onRemoveProject={(groupId) => {
                  const projectId = localProjectIdFor(groupId)
                  if (!projectId) return
                  void rpc
                    .invoke('project.remove', { id: projectId })
                    .then(refreshProjects)
                    .catch((error: unknown) => log.warn('rpc call failed', error))
                }}
                onReorderProject={(groupId, beforeGroupId) => {
                  const id = localProjectIdFor(groupId)
                  const before = beforeGroupId ? localProjectIdFor(beforeGroupId) : null
                  if (id) moveProject(id, before)
                }}
                onMoveProject={(groupId, delta) => {
                  const projectId = localProjectIdFor(groupId)
                  if (!projectId) return
                  const move = projectMoveForDelta(
                    openProjects.map((p) => p.id),
                    projectId,
                    delta,
                  )
                  if (move) moveProject(move.id, move.beforeId)
                }}
                onLocateProject={(groupId) => {
                  const id = localProjectIdFor(groupId)
                  if (id) openProjectViaDialog(id)
                }}
                activeSessionId={activeSessionId}
                startedByAria={(id) => ariaStartedIds.has(id)}
                activityOf={activityOf}
                hostOf={(id) => navigation.hosts.get(id)}
                onSelect={selectSession}
                onOpenInSplit={splitLayoutActions.openInSplit}
                onRename={(id, title) => patchSessions([id], { title })}
                onDelete={(id) => {
                  const dropped = new Set([id, ...descendantIds(navigation.sessions, id)])
                  for (const gone of dropped) forget(gone)
                  void destroyScopedSession(id)
                    // The refreshed list blanks the panes those sessions were in.
                    .then(() => {
                      for (const gone of dropped) {
                        deleteSessionDraftIntent(gone)
                        deleteSessionDraftText(gone)
                        writeReviewDrafts(gone, [])
                      }
                      refreshSessions()
                    })
                    .catch((error: unknown) => log.warn('rpc call failed', error))
                }}
                onTogglePin={(id, pinned) => patchSessions([id], { pinned })}
                onToggleArchive={(id, archived) => patchSessions([id], { archived })}
                onArchiveMany={(ids) => patchSessions(ids, { archived: true })}
                onDeleteMany={(ids) => {
                  const dropped = new Set<string>()
                  for (const id of ids) {
                    dropped.add(id)
                    for (const child of descendantIds(navigation.sessions, id)) dropped.add(child)
                  }
                  for (const gone of dropped) forget(gone)
                  void (async () => {
                    for (const id of ids) {
                      try {
                        await destroyScopedSession(id)
                        for (const gone of [id, ...descendantIds(navigation.sessions, id)]) {
                          deleteSessionDraftIntent(gone)
                          deleteSessionDraftText(gone)
                          writeReviewDrafts(gone, [])
                        }
                      } catch (error: unknown) {
                        log.warn('rpc call failed', error)
                      }
                    }
                    refreshSessions()
                  })()
                }}
              />
              <SidebarFooter activeTool={activeTool} onSelectTool={selectWorkspaceTool} />
            </motion.aside>
          ) : null}
        </AnimatePresence>

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
            data-dragging={sidebar.dragging ? '' : undefined}
            className="ari-sidebar-resize -mx-1 w-2 shrink-0 cursor-col-resize focus-visible:outline-none"
          />
        ) : null}

        <main
          className={`flex min-w-0 flex-1 flex-col pb-[var(--ari-frame-gap)] pr-[var(--ari-frame-gap)] ${
            sidebarOpen ? '' : 'pl-[var(--ari-frame-gap)]'
          }`}
        >
          <SpaceTabs
            spaces={spaceStore.spaces}
            activeSpaceId={spaceStore.activeSpaceId}
            statusOf={(space) => spaceStatus(space, (id) => activityOf(id)?.phase)}
            onSelect={spaceActions.select}
            onCreate={createSpace}
            onClose={spaceActions.close}
            onRename={spaceActions.rename}
            onReorder={spaceActions.move}
            canCreate={spaceStore.spaces.length < MAX_SPACES}
          />
          {fullPage !== null ? (
            <div
              key={fullPage}
              id="space-panel"
              role="tabpanel"
              aria-labelledby={`space-tab-${spaceStore.activeSpaceId}`}
              className="ari-stage ari-enter-rise min-h-0 flex-1"
            >
              {fullPage === 'usage' ? (
                <ErrorBoundary label="Usage">
                  <UsagePage />
                </ErrorBoundary>
              ) : fullPage === 'changes' || fullPage === 'source-control' ? (
                <ErrorBoundary label="Changes">
                  <SessionClientProvider
                    scope={changesClientScope ?? { kind: 'local', sessionId: '' }}
                  >
                    <ChangesView
                      initialTab={sourceControlTab}
                      onTabChange={setSourceControlTab}
                      onDock={() => {
                        setFullPage(null)
                        setInspector('changes')
                      }}
                      onClose={() => setFullPage(null)}
                      sessionId={changesWireSessionId}
                      projectId={changesClientScope?.kind === 'remote' ? null : changesProjectId}
                      onRange={
                        activeSessionId && changesSessionId === activeSessionId
                          ? attachReviewRange
                          : undefined
                      }
                      onCheckedOut={(path) =>
                        openCheckedOutWorktree(path, {
                          open: (folder) => rpc.invoke('project.open', { path: folder }),
                          refreshProjects,
                          startSession: (projectId) => {
                            setFullPage(null)
                            createSession(projectId)
                          },
                        })
                      }
                    />
                  </SessionClientProvider>
                </ErrorBoundary>
              ) : null}
            </div>
          ) : null}
          <div
            className={`${fullPage === null ? 'flex' : 'hidden'} min-h-0 flex-1`}
            hidden={fullPage !== null}
            inert={fullPage !== null}
          >
            <div
              id={fullPage === null ? 'space-panel' : undefined}
              role="tabpanel"
              aria-labelledby={`space-tab-${spaceStore.activeSpaceId}`}
              className="ari-stage min-h-0 min-w-0 flex-1"
            >
              {/* The spaces visited last stay mounted, hidden: switching is a
                    same-frame swap, and every session and terminal in the
                    space comes back exactly as it was left. */}
              {mountedSpaces.map((space) => {
                const visible = space.id === spaceStore.activeSpaceId
                const layout = space.layout
                const activeSessionId = activeSessionOf(layout)
                return (
                  <div
                    key={space.id}
                    hidden={!visible}
                    inert={!visible}
                    className={`absolute inset-0 min-h-0 min-w-0 flex-col ${visible ? 'flex' : 'hidden'}`}
                  >
                    {activeSessionId === null &&
                    paneCount(layout) === 1 &&
                    !projectDrafts.some(
                      (draft) =>
                        draft.spaceId === space.id && draft.paneId === activePaneOf(layout),
                    ) &&
                    (leaves(layout.root)[0] === undefined ||
                      isBlankLeaf(leaves(layout.root)[0]!)) ? (
                      // Nothing open at all: the welcome panel is still the view.
                      <ErrorBoundary label="Welcome">
                        <WelcomePanel
                          hasProjects={projects.length > 0}
                          startPending={sessionStart.pending}
                          onStartIntent={() =>
                            sessionStart.canStart() ? captureStartIntent() : null
                          }
                          onCreateSession={beginNewSession}
                          onConnect={(endpointId, anchor, intent) =>
                            beginNewSession(
                              anchor,
                              {
                                driverKind: 'ari-core',
                                modelId: `ep:${endpointId}`,
                              },
                              intent,
                            )
                          }
                        />
                      </ErrorBoundary>
                    ) : (
                      <ErrorBoundary label="Session">
                        <SplitView
                          layout={layout}
                          titleOf={(id) => {
                            const session = navigation.sessions.find((s) => s.id === id)
                            if (session === undefined) return null
                            if (isHelmSession(session)) return 'Aria'
                            const projectName =
                              session.projectId === UNFILED_GROUP_ID
                                ? null
                                : (navigation.sidebarProjects.find(
                                    (p) => p.id === session.projectId,
                                  )?.name ?? null)
                            return formatPaneTitle(session.title, projectName)
                          }}
                          onFocus={splitLayoutActions.focus}
                          onClose={splitLayoutActions.close}
                          onSplit={splitLayoutActions.split}
                          onToggleZoom={splitLayoutActions.toggleZoom}
                          onResize={splitLayoutActions.resize}
                          onDropSession={splitLayoutActions.dropSession}
                          onDropPane={splitLayoutActions.dropPane}
                          onOpenTerminal={openTerminalInPane}
                          canOpenTerminal={canOpenTerminalInPane}
                          terminalTitleOf={(id) =>
                            terminalDock.tabs.find((tab) => tab.id === id)?.title ?? 'Terminal'
                          }
                          renderTerminal={(terminalId, paneId) => {
                            const tab = terminalDock.tabs.find((entry) => entry.id === terminalId)
                            return (
                              <ErrorBoundary label="Terminal">
                                <div className="h-full min-h-0 overflow-hidden">
                                  <SessionClientProvider
                                    scope={
                                      tab?.owner?.kind === 'remote'
                                        ? tab.owner
                                        : { kind: 'local', sessionId: '' }
                                    }
                                  >
                                    <TerminalPane
                                      key={`${paneId}:${terminalId}`}
                                      terminalId={terminalId}
                                      cwd={tab?.cwd ?? shellRoot}
                                      initialCommand={tab?.command}
                                      active={visible && paneId === activePaneOf(layout)}
                                    />
                                  </SessionClientProvider>
                                </div>
                              </ErrorBoundary>
                            )
                          }}
                          renderSession={(current, paneId) =>
                            // With Aria switched off her chat is not drawn at all.
                            sessionsLoadedRef.current &&
                            (ariaEnabled ||
                              !listedSessions.some(
                                (session) => session.id === current && isHelmSession(session),
                              )) ? (
                              // One view per session, never reused for another: composer
                              // seeds and review notes belong to the session, not to the
                              // position it sits in. Recent ones stay mounted, hidden.
                              <SessionKeepAlive
                                key={paneId}
                                poolId={paneId}
                                sessionId={current}
                                canRender={(sessionId) =>
                                  ariaEnabled ||
                                  !listedSessions.some(
                                    (session) => session.id === sessionId && isHelmSession(session),
                                  )
                                }
                                hidden={!visible}
                                render={(sessionId, hidden) => {
                                  const scope = parseSessionViewKey(sessionId)
                                  if (!scope)
                                    return (
                                      <div className="p-4 text-sm text-fg-muted" role="status">
                                        This saved session scope is unavailable.
                                      </div>
                                    )
                                  return (
                                    <SessionView
                                      sessionId={scope.sessionId}
                                      scope={scope}
                                      onOpenAria={ariaEnabled ? () => openAria() : undefined}
                                      startedByAria={ariaStartedIds.has(sessionId)}
                                      ariaStatus={ariaStatus}
                                      hidden={hidden}
                                      onComposerReady={
                                        composerFocusRequest?.sessionId === sessionId &&
                                        composerFocusRequest.intent.scope.spaceId === space.id &&
                                        composerFocusRequest.intent.scope.paneId === paneId
                                          ? composerFocusRequest.intent.ready
                                          : undefined
                                      }
                                      defaults={defaultsFor(sessionId)}
                                      onDefaultsChange={(next) => writeDefaults(sessionId, next)}
                                      onPick={
                                        parseSessionViewKey(sessionId)?.kind === 'local'
                                          ? rememberPick
                                          : undefined
                                      }
                                      // A child session opens in the pane it was opened from,
                                      // rather than yanking the whole shell to it.
                                      onOpenSession={(childId) =>
                                        splitLayoutActions.assign(paneId, childId)
                                      }
                                      activityOf={activityOf}
                                      childSessions={navigation.sessions
                                        .filter(
                                          (session) =>
                                            session.parentSessionId === sessionId &&
                                            !session.archived,
                                        )
                                        .map((session) => ({
                                          ...session,
                                          id:
                                            parseSessionViewKey(session.id)?.sessionId ??
                                            session.id,
                                          parentSessionId: session.parentSessionId
                                            ? (parseSessionViewKey(session.parentSessionId)
                                                ?.sessionId ?? session.parentSessionId)
                                            : null,
                                        }))}
                                      sessionTitle={sessionTitle}
                                      parentSession={(() => {
                                        const parent = parentOf(navigation.sessions, sessionId)
                                        return parent
                                          ? {
                                              ...parent,
                                              id:
                                                parseSessionViewKey(parent.id)?.sessionId ??
                                                parent.id,
                                            }
                                          : null
                                      })()}
                                    />
                                  )
                                }}
                              />
                            ) : null
                          }
                          renderBlank={(paneId) => renderProjectDraft(space.id, paneId)}
                          blankTitleOf={(paneId) =>
                            projectDrafts.find(
                              (draft) => draft.spaceId === space.id && draft.paneId === paneId,
                            )?.group.name ?? null
                          }
                        />
                      </ErrorBoundary>
                    )}
                  </div>
                )
              })}
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
                  data-dragging={dock.dragging ? '' : undefined}
                  className="ari-sidebar-resize w-[var(--ari-frame-gap)] shrink-0 cursor-col-resize focus-visible:outline-none"
                />
                <motion.aside
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={reducedMotion ? { duration: 0 } : transitions.fadeUp}
                  role="complementary"
                  aria-label={INSPECTOR_TITLES[inspector]}
                  className="ari-stage flex shrink-0 flex-col"
                  style={{
                    width:
                      inspector === 'overview'
                        ? Math.min(dock.width, OVERVIEW_MAX_WIDTH)
                        : dock.width,
                    maxWidth: '60vw',
                  }}
                >
                  <PanelTabs
                    tabs={ariaActive ? [OVERVIEW_TAB, ...PANEL_TABS] : PANEL_TABS}
                    active={inspector}
                    onSelect={(id) => {
                      if (id === 'changes') setSourceControlTab('changes')
                      setInspector(id)
                    }}
                    onClose={() => {
                      // Closing her overview is a choice; it stays closed.
                      if (inspector === 'overview') overviewDismissedRef.current = true
                      setInspector(null)
                    }}
                  />
                  {inspector === 'overview' ? (
                    <div className="min-h-0 flex-1">
                      <ErrorBoundary label="Overview">
                        <AriaOverview
                          sessions={sessions}
                          activityOf={activityOf}
                          attentionCountOf={attentionCountOf}
                          projectNameOf={(projectId) =>
                            projects.find((project) => project.id === projectId)?.name ?? null
                          }
                          onOpen={selectSession}
                        />
                      </ErrorBoundary>
                    </div>
                  ) : inspector === 'terminal' ? (
                    <div className="min-h-0 flex-1">
                      <ErrorBoundary label="Terminal">
                        <SessionClientProvider
                          scope={activeSessionScope ?? { kind: 'local', sessionId: '' }}
                        >
                          <TerminalDock
                            cwd={remoteActive ? '.' : shellRoot}
                            paneTerminalIds={paneTerminalIds}
                            onAddProject={() => openProjectViaDialog()}
                            onClose={() => setInspector(null)}
                          />
                        </SessionClientProvider>
                      </ErrorBoundary>
                    </div>
                  ) : inspector === 'browser' ? (
                    <div className="min-h-0 flex-1">
                      <ErrorBoundary label="Browser">
                        <BrowserPanel
                          sessionId={remoteActive ? undefined : (activeSessionId ?? undefined)}
                          onClose={() => setInspector(null)}
                        />
                      </ErrorBoundary>
                    </div>
                  ) : (
                    <>
                      <div className="min-h-0 flex-1">
                        {inspector === 'changes' ? (
                          <ErrorBoundary label="Changes">
                            <SessionClientProvider
                              scope={changesClientScope ?? { kind: 'local', sessionId: '' }}
                            >
                              <ChangesView
                                initialTab={sourceControlTab}
                                onTabChange={setSourceControlTab}
                                onExpand={() => {
                                  setInspector(null)
                                  setFullPage('changes')
                                }}
                                sessionId={changesWireSessionId}
                                projectId={
                                  changesClientScope?.kind === 'remote' ? null : changesProjectId
                                }
                                onRange={
                                  activeSessionId && changesSessionId === activeSessionId
                                    ? attachReviewRange
                                    : undefined
                                }
                                onCheckedOut={(path) =>
                                  openCheckedOutWorktree(path, {
                                    open: (folder) => rpc.invoke('project.open', { path: folder }),
                                    refreshProjects,
                                    startSession: (projectId) => {
                                      setInspector(null)
                                      createSession(projectId)
                                    },
                                  })
                                }
                              />
                            </SessionClientProvider>
                          </ErrorBoundary>
                        ) : activeProjectPath && activeScope ? (
                          <SessionClientProvider
                            scope={activeSessionScope ?? { kind: 'local', sessionId: '' }}
                          >
                            <FileExplorer root={activeProjectPath} scope={activeScope} />
                          </SessionClientProvider>
                        ) : (
                          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-subtle">
                            Open a project to browse its files here.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </motion.aside>
              </>
            ) : null}
          </div>
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
        open={searchOpen && !remoteActive}
        onClose={() => setSearchOpen(false)}
        root={remoteActive ? null : activeProjectPath}
        scope={remoteActive ? null : activeScope}
      />
      {setupCovered ? null : <KeyboardCheatSheet />}
      <NewSessionLauncher
        open={newSessionRequest !== null}
        projects={navigation.sidebarProjects
          .filter(
            (project) =>
              !newSessionRequest?.preferredHostId ||
              navigation.groups
                .find((group) => group.id === project.id)
                ?.checkouts.some(
                  (checkout) => checkout.hostId === newSessionRequest.preferredHostId,
                ),
          )
          .map((project) => ({
            ...project,
            path:
              project.path ??
              navigation.groups.find((group) => group.id === project.id)?.label ??
              'Host checkout',
            lastOpenedAt: 0,
            createdAt: 0,
          }))}
        sessions={navigation.sessions}
        preferredProjectId={activeSession?.projectId ?? null}
        onCreate={(projectId, lead) => {
          const overrides = newSessionRequest?.overrides
          createSession(projectId, lead ? { ...overrides, lead: true } : overrides)
        }}
        onAddProject={() => addProjectAndStart(newSessionRequest?.overrides)}
        onClose={closeNewSessionMenu}
      />
      {draftHandoff && (
        <DraftHandoff
          key={sessionViewKey(draftHandoff.scope)}
          viewKey={sessionViewKey(draftHandoff.scope)}
          seed={draftHandoff.seed}
          onApplied={() => {
            finishProjectDraft(draftHandoff.entry, draftHandoff.scope)
            setDraftHandoff(null)
          }}
        />
      )}
    </div>
  )
}

/** Theme, motion, and toast context for the whole renderer tree. */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider persistence={themePersistence}>
      <RendererMotion>
        <ToastProvider>
          <MachinesProvider>
            <UpdateToastWatcher />
            {children}
          </MachinesProvider>
        </ToastProvider>
      </RendererMotion>
    </ThemeProvider>
  )
}

function RendererMotion({ children }: { children: React.ReactNode }) {
  const { settings } = useEngineSettings()
  const reducedMotion = settings?.appearance.reducedMotion ?? false
  useEffect(() => {
    if (!settings) return
    applyAppearance(settings.appearance)
    cacheAppearance(settings.appearance)
  }, [settings])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-ari-reduced-motion', reducedMotion)
    return () => document.documentElement.removeAttribute('data-ari-reduced-motion')
  }, [reducedMotion])
  return <MotionProvider reducedMotion={reducedMotion}>{children}</MotionProvider>
}

/** Headless: announces provider updates once the toast context exists. */
function UpdateToastWatcher() {
  useVoicePlayback()
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
      {booted ? <OnboardingGate>{(props) => <Shell {...props} />}</OnboardingGate> : null}
      {launched ? null : <AwakenSplash ready={booted} onDone={finishLaunch} />}
    </AppProviders>
  )
}
