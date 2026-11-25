import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { RemoteModelCatalog, RemoteProject, RemoteSessionSummary } from '@ari/contracts/remote'
import { DeviceKeyring, type DeviceStore } from './device-key'
import { LifecycleDeviceStore } from './lifecycle-device-store'
import { GatewayClient, RemoteError } from './gateway-client'
import { MobileSession, type ConnectionState } from './session'
import { IS_CONNECT_BUILD } from './connect'
import { visibleProjects, visibleSessions } from './visibility'
import { routeUrl } from './routes'
import {
  computerAddress,
  computerDestination,
  forgetComputerState,
  LEGACY_ORIGIN_KEY,
  readComputers,
  saveComputer,
  takeComputerDirectory,
  writeComputers,
  type SavedComputer,
} from './computers'

const ORIGIN_KEY = LEGACY_ORIGIN_KEY
const RECONNECT_DELAY_MS = 2000
/** Ceiling for the retry backoff while the computer cannot be reached. */
const MAX_RETRY_DELAY_MS = 30_000
const REFRESH_INTERVAL_MS = 15_000
const navigateToComputer = (href: string): void => location.assign(href)

/**
 * How long to wait before the next automatic attempt. A tailnet path that
 * drops rarely fires `online` when it comes back, so an unreachable computer
 * is retried for as long as the app is on screen, more slowly each time.
 */
export function retryDelay(failures: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, RECONNECT_DELAY_MS * 2 ** Math.max(0, failures))
}

/** Keeps the previous value when a poll returns the same data, so nothing re-renders. */
function same<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

function canReconnect(state: ConnectionState): boolean {
  return (
    state === 'connected' ||
    state === 'connecting' ||
    state === 'reconnecting' ||
    state === 'unreachable'
  )
}
export interface AppValue {
  computers: SavedComputer[]
  activeComputer: SavedComputer | null
  addComputer: (address: string, name?: string) => void
  switchComputer: (origin: string) => void
  renameComputer: (origin: string, name: string) => void
  origin: string | null
  booted: boolean
  connection: ConnectionState
  session: MobileSession | null
  capabilities: readonly string[]
  projects: RemoteProject[]
  sessions: RemoteSessionSummary[]
  catalog: RemoteModelCatalog | null
  /**
   * Bumped each time the app returns to the foreground or the network comes
   * back. Screens that hold a live stream reopen it and reconcile, rather than
   * trusting a socket the phone may have frozen while it was away.
   */
  wake: number
  error: string | null
  refreshing: boolean
  lastSyncedAt: number | null
  pairingCode: string | null
  managedComputerId: string | null
  chooseComputer: (computerId: string, origin: string) => void
  changeComputer: () => void
  refresh: () => Promise<void>
  pair: (invitationId: string, displayName: string) => Promise<void>
  reconnect: () => Promise<void>
  forget: () => Promise<void>
  rememberOrigin: (origin: string) => void
}
const AppContext = createContext<AppValue | null>(null)

/** Shared desktop state; credentials and tokens stay inside the connection. */
export function useApp(): AppValue {
  const value = useContext(AppContext)
  if (value === null) throw new Error('useApp outside its provider')
  return value
}

/** Invitations are fragments so HTTP servers and relay logs never receive them. */
export function takeInvitationFromUrl(href: string): string | null {
  const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
  const invitationId = new URLSearchParams(fragment).get('pair')
  if (invitationId !== null) history.replaceState(null, '', href.split('#')[0] ?? '/')
  return invitationId
}
function initialOrigin(): string | null {
  if (IS_CONNECT_BUILD) return null
  // A private host serves its own PWA. A remembered address is directory metadata,
  // never permission to fetch another host from this origin.
  return location.protocol.startsWith('http') ? location.origin : null
}

/** Each origin owns a separate device key; foregrounding renews authorization and data. */
export function AppProvider({
  store,
  children,
  navigateTo = navigateToComputer,
}: {
  store: DeviceStore
  children: ReactNode
  /** Injectable navigation for deterministic origin-boundary tests. */
  navigateTo?: (href: string) => void
}): ReactNode {
  const [origin, setOrigin] = useState<string | null>(initialOrigin)
  const [computers, setComputers] = useState<SavedComputer[]>(() => {
    let saved = takeComputerDirectory(location.href, readComputers())
    const initial = initialOrigin()
    if (initial !== null) saved = saveComputer(saved, initial)
    // StrictMode may run this initializer again after the fragment was consumed.
    writeComputers(saved)
    return saved
  })
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [booted, setBooted] = useState(false)
  const [capabilities, setCapabilities] = useState<readonly string[]>([])
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([])
  const [wake, setWake] = useState(0)
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [managedComputerId, setManagedComputerId] = useState<string | null>(null)
  const [linked, setLinked] = useState<MobileSession | null>(null)
  const live = useRef<MobileSession | null>(null)
  const forgetting = useRef<Promise<void> | null>(null)
  const canSelectComputer = useCallback((): void => {
    if (forgetting.current !== null)
      throw new Error('Wait for this computer to be forgotten before opening another.')
  }, [])
  const connectionOwner = useRef<{
    session: MobileSession
    connect: () => Promise<void>
    controller: AbortController
    pairing: Promise<void> | null
  } | null>(null)
  const abandonConnection = useCallback((): void => {
    const owner = connectionOwner.current
    owner?.controller.abort()
    owner?.session.disconnect()
    live.current = null
  }, [])
  const refreshingSession = useRef<MobileSession | null>(null)
  const catalogFor = useRef<MobileSession | null>(null)
  /** Set by the connection owner: a read found the computer unreachable. */
  const lost = useRef<(() => void) | null>(null)
  useEffect(() => {
    writeComputers(computers)
  }, [computers])
  const keyring = useMemo(
    () =>
      new DeviceKeyring(
        new LifecycleDeviceStore(origin === null ? store : (store.forOrigin?.(origin) ?? store)),
      ),
    [origin, store],
  )
  const refreshWith = useCallback(async (session: MobileSession): Promise<void> => {
    if (live.current !== session || !session.usable || refreshingSession.current === session) return
    refreshingSession.current = session
    setRefreshing(true)
    try {
      const [nextProjects, nextSessions, nextCatalog] = await Promise.all([
        session.query<RemoteProject[]>('project.list'),
        session.query<RemoteSessionSummary[]>('session.list'),
        // The catalog rarely changes and is the largest of the three; it is
        // read once per connection rather than on every poll.
        session.supports('models.list') && catalogFor.current !== session
          ? session.query<RemoteModelCatalog>('models.list')
          : Promise.resolve(undefined),
      ])
      if (live.current !== session || !session.usable) return
      setProjects((previous) => same(previous, visibleProjects(nextProjects)))
      setSessions((previous) => same(previous, visibleSessions(nextSessions)))
      if (nextCatalog !== undefined) {
        catalogFor.current = session
        setCatalog(nextCatalog)
      } else if (!session.supports('models.list')) setCatalog(null)
      setLastSyncedAt(Date.now())
      setError(null)
    } catch (failure) {
      if (
        live.current === session &&
        session.state !== 'revoked' &&
        session.state !== 'unknown-device'
      ) {
        // A poll that cannot reach the computer means the link is down, even
        // though no stream reported it: say so and start recovering.
        if (failure instanceof RemoteError && failure.code === 'unreachable') lost.current?.()
        else setError(failure instanceof Error ? failure.message : 'The computer did not answer.')
      }
    } finally {
      if (refreshingSession.current === session) {
        refreshingSession.current = null
        setRefreshing(false)
      }
    }
  }, [])
  useEffect(() => {
    setLinked(null)
    setCapabilities([])
    setProjects([])
    setSessions([])
    setCatalog(null)
    setLastSyncedAt(null)
    setPairingCode(null)
    setError(null)
    if (origin === null) {
      live.current = null
      setConnection('unpaired')
      setBooted(true)
      return
    }
    let cancelled = false
    let refused = false
    let connecting: Promise<void> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    /** Unreachable cycles in a row, for the backoff. */
    let failures = 0
    const controller = new AbortController()
    const cancelRetry = (): void => {
      if (retry !== null) clearTimeout(retry)
      retry = null
    }
    const scheduleReconnect = (delay = RECONNECT_DELAY_MS): void => {
      if (cancelled || retry !== null) return
      retry = setTimeout(() => {
        retry = null
        void connect()
      }, delay)
    }
    const client = new GatewayClient({ origin })
    const session = new MobileSession({
      keyring,
      client,
      ...(managedComputerId === null ? {} : { managedComputerId }),
      onState: (state) => {
        if (cancelled || live.current !== session) return
        refused = !canReconnect(state)
        if (state === 'reconnecting') scheduleReconnect()
        else cancelRetry()
        setConnection(state)
        setComputers((saved) =>
          saved.map((computer) =>
            computer.origin === origin
              ? {
                  ...computer,
                  status: state,
                  lastConnectedAt: state === 'connected' ? Date.now() : computer.lastConnectedAt,
                }
              : computer,
          ),
        )
        if (!canReconnect(state)) {
          setCapabilities([])
          setProjects([])
          setSessions([])
          setCatalog(null)
          setLastSyncedAt(null)
          setError(null)
        }
      },
      onPairCode: (code) => {
        if (!cancelled && live.current === session) setPairingCode(code)
      },
    })
    live.current = session
    setLinked(session)
    // One owner for startup, dropped streams, foreground, online and manual recovery.
    // MobileSession bounds each connection cycle; an exhausted cycle is tried
    // again with a growing delay while the app is on screen.
    const connect = (trigger: 'initial' | 'automatic' | 'manual' = 'automatic'): Promise<void> => {
      const retryAfterUpdate = trigger === 'manual' && session.state === 'version-mismatch'
      if (
        cancelled ||
        live.current !== session ||
        (trigger !== 'initial' && refused && !retryAfterUpdate)
      )
        return Promise.resolve()
      cancelRetry()
      if (connecting !== null) return connecting
      setError(null)
      connecting = (async () => {
        let connected = false
        let unreachable = false
        try {
          // A drop or a return to the foreground resumes the existing token;
          // a cold start or the user's own retry authorizes from scratch.
          const state = await session.connect(
            controller.signal,
            trigger === 'automatic' ? { resume: true } : {},
          )
          if (cancelled || live.current !== session) return
          refused = !canReconnect(state)
          connected = state === 'connected'
          unreachable = state === 'unreachable'
          failures = unreachable ? failures + 1 : 0
          setConnection(state)
          setCapabilities(session.usable ? session.capabilities : [])
          if (trigger !== 'automatic') catalogFor.current = null
          if (state === 'connected') await refreshWith(session)
        } catch (failure) {
          if (!cancelled && live.current === session) {
            cancelRetry()
            setCapabilities([])
            setError(
              failure instanceof Error ? failure.message : 'Could not read this device identity.',
            )
            setConnection('unreachable')
          }
        } finally {
          connecting = null
          if (!cancelled && live.current === session) {
            setBooted(true)
            if (connected && session.state === 'reconnecting') scheduleReconnect()
            else if (unreachable && document.visibilityState === 'visible')
              scheduleReconnect(retryDelay(failures))
          }
        }
      })()
      return connecting
    }
    lost.current = () => {
      if (!cancelled && live.current === session) void connect()
    }
    connectionOwner.current = {
      session,
      connect: () => connect('manual'),
      controller,
      pairing: null,
    }
    void connect('initial')
    const visible = (): void => {
      if (document.visibilityState !== 'visible') return
      // Whatever was open before the phone slept is suspect; screens reopen
      // their streams on this tick and reconcile from where they left off.
      setWake((count) => count + 1)
      failures = 0
      void connect()
    }
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshWith(session)
    }, REFRESH_INTERVAL_MS)
    // The phone knows it lost its network before any socket does: check now
    // rather than showing a live-looking screen until a heartbeat misses.
    const offline = (): void => {
      if (session.state === 'connected') void connect()
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    window.addEventListener('offline', offline)
    // iOS restores a page from the back-forward cache without a visibility change.
    const restored = (event: PageTransitionEvent): void => {
      if (event.persisted) visible()
    }
    window.addEventListener('pageshow', restored)
    return () => {
      cancelled = true
      controller.abort()
      session.disconnect()
      cancelRetry()
      if (live.current === session) live.current = null
      if (connectionOwner.current?.session === session) connectionOwner.current = null
      lost.current = null
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', visible)
      window.removeEventListener('offline', offline)
      window.removeEventListener('pageshow', restored)
    }
  }, [origin, keyring, refreshWith, managedComputerId])
  const refresh = useCallback(async (): Promise<void> => {
    if (linked !== null) await refreshWith(linked)
  }, [linked, refreshWith])
  const pair = useCallback(
    async (invitationId: string, displayName: string): Promise<void> => {
      if (linked === null) throw new Error('Choose a computer first.')
      const owner = connectionOwner.current
      if (owner === null || owner.session !== linked)
        throw new Error('Choose this computer again before pairing.')
      if (owner.pairing !== null)
        throw new Error('A pairing attempt is already waiting for this computer.')
      const pending = linked.pair(invitationId, displayName, owner.controller.signal)
      owner.pairing = pending
      try {
        await pending
      } finally {
        if (owner.pairing === pending) owner.pairing = null
      }
      if (live.current !== linked) return
      setConnection(linked.state)
      setCapabilities(linked.capabilities)
      await refreshWith(linked)
    },
    [linked, refreshWith],
  )
  const reconnect = useCallback(async (): Promise<void> => {
    await connectionOwner.current?.connect()
  }, [])
  const forget = useCallback(async (): Promise<void> => {
    if (forgetting.current !== null) return forgetting.current
    const selected = origin
    // Close the visible workspace before deleting its credential. Late reads cannot repaint it.
    abandonConnection()
    setLinked(null)
    setOrigin(null)
    setManagedComputerId(null)
    setConnection('unpaired')
    // The local store generation rejects delayed pairing writes; no remote wait is needed.
    const pending = (async () => {
      await keyring.forget()
      if (selected !== null) {
        forgetComputerState(selected)
        setComputers((saved) => saved.filter((computer) => computer.origin !== selected))
      }
      try {
        if (localStorage.getItem(ORIGIN_KEY) === selected) localStorage.removeItem(ORIGIN_KEY)
      } catch (failure) {
        console.warn('Could not forget the saved address', failure)
      }
    })()
    forgetting.current = pending
    try {
      await pending
    } finally {
      if (forgetting.current === pending) forgetting.current = null
    }
  }, [keyring, origin, abandonConnection])
  const rememberOrigin = useCallback(
    (next: string): void => {
      canSelectComputer()
      const url = computerAddress(next, !IS_CONNECT_BUILD)
      if (!IS_CONNECT_BUILD && url.origin !== location.origin) {
        abandonConnection()
        setLinked(null)
        setOrigin(null)
        setBooted(true)
        setConnection('unpaired')
        navigateTo(computerDestination(url.href, saveComputer(computers, url.origin)))
        return
      }
      try {
        localStorage.setItem(ORIGIN_KEY, url.origin)
      } catch (failure) {
        console.warn('Could not save the computer address', failure)
      }
      if (url.origin === origin) return
      history.replaceState(
        null,
        '',
        routeUrl({ destination: 'home', sessionId: null }, location.href),
      )
      setBooted(false)
      abandonConnection()
      setLinked(null)
      setProjects([])
      setSessions([])
      setCapabilities([])
      setCatalog(null)
      setPairingCode(null)
      setError(null)
      setConnection('connecting')
      setComputers((saved) => saveComputer(saved, url.origin))
      setOrigin(url.origin)
    },
    [origin, computers, navigateTo, abandonConnection, canSelectComputer],
  )
  const chooseComputer = useCallback(
    (computerId: string, next: string): void => {
      canSelectComputer()
      if (!IS_CONNECT_BUILD) throw new Error('This build uses your own private network.')
      setManagedComputerId(computerId)
      setComputers((saved) => saveComputer(saved, next, undefined, computerId))
      rememberOrigin(next)
    },
    [rememberOrigin, canSelectComputer],
  )
  const changeComputer = useCallback((): void => {
    abandonConnection()
    setLinked(null)
    setProjects([])
    setSessions([])
    setCatalog(null)
    setCapabilities([])
    setError(null)
    setOrigin(null)
    setManagedComputerId(null)
    setBooted(true)
    setConnection('unpaired')
  }, [abandonConnection])
  const switchComputer = useCallback(
    (next: string): void => {
      canSelectComputer()
      const computer = computers.find((entry) => entry.origin === next)
      if (IS_CONNECT_BUILD) {
        if (computer?.managedComputerId === undefined)
          throw new Error('Choose this computer from Ari Connect.')
        chooseComputer(computer.managedComputerId, computer.origin)
        return
      }
      const destination = computerAddress(next)
      if (destination.origin !== location.origin) {
        changeComputer()
        navigateTo(computerDestination(destination.href, computers))
        return
      }
      setManagedComputerId(null)
      if (origin === destination.origin) void reconnect()
      else rememberOrigin(destination.origin)
    },
    [
      computers,
      chooseComputer,
      origin,
      reconnect,
      rememberOrigin,
      changeComputer,
      navigateTo,
      canSelectComputer,
    ],
  )
  const addComputer = useCallback(
    (address: string, name?: string): void => {
      canSelectComputer()
      if (IS_CONNECT_BUILD)
        throw new Error('Choose computers from your approved Ari Connect account.')
      const destination = computerAddress(address)
      const saved = saveComputer(computers, destination.origin, name)
      setComputers(saved)
      writeComputers(saved)
      if (destination.origin !== location.origin) {
        changeComputer()
        navigateTo(computerDestination(destination.href, saved))
        return
      }
      if (destination.hash) navigateTo(computerDestination(destination.href, saved))
      else if (origin === destination.origin) void reconnect()
      else rememberOrigin(destination.origin)
    },
    [computers, origin, reconnect, rememberOrigin, changeComputer, navigateTo, canSelectComputer],
  )
  const renameComputer = useCallback((selected: string, name: string): void => {
    if (!name.trim()) throw new Error('Give this computer a name.')
    setComputers((saved) =>
      saved.map((computer) =>
        computer.origin === selected ? { ...computer, name: name.trim().slice(0, 80) } : computer,
      ),
    )
  }, [])
  const activeComputer = computers.find((computer) => computer.origin === origin) ?? null
  return (
    <AppContext.Provider
      value={{
        computers,
        activeComputer,
        addComputer,
        switchComputer,
        renameComputer,
        origin,
        booted,
        connection,
        session: linked,
        capabilities,
        projects,
        sessions,
        catalog,
        wake,
        error,
        refreshing,
        lastSyncedAt,
        pairingCode,
        managedComputerId,
        chooseComputer,
        changeComputer,
        refresh,
        pair,
        reconnect,
        forget,
        rememberOrigin,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}
