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
import type { RemoteModelCatalog, RemoteProject } from '@ari/contracts/remote'
import type { SessionSummary } from '@ari/contracts/rpc'
import { DeviceKeyring, type DeviceStore } from './device-key'
import { LifecycleDeviceStore } from './lifecycle-device-store'
import { GatewayClient } from './gateway-client'
import { MobileSession, type ConnectionState } from './session'
import { IS_CONNECT_BUILD } from './connect'
import { visibleProjects, visibleSessions } from './visibility'
import { routeUrl } from './routes'
import {
  computerAddress, computerDestination, forgetComputerState, LEGACY_ORIGIN_KEY,
  readComputers, saveComputer, takeComputerDirectory, writeComputers, type SavedComputer,
} from './computers'

const ORIGIN_KEY = LEGACY_ORIGIN_KEY
const RECONNECT_DELAY_MS = 2000
const navigateToComputer = (href: string): void => location.assign(href)

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
  sessions: SessionSummary[]
  catalog: RemoteModelCatalog | null
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
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [managedComputerId, setManagedComputerId] = useState<string | null>(null)
  const [linked, setLinked] = useState<MobileSession | null>(null)
  const live = useRef<MobileSession | null>(null)
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
  useEffect(() => { writeComputers(computers) }, [computers])
  const keyring = useMemo(
    () => new DeviceKeyring(new LifecycleDeviceStore(origin === null ? store : (store.forOrigin?.(origin) ?? store))),
    [origin, store],
  )
  const refreshWith = useCallback(async (session: MobileSession): Promise<void> => {
    if (live.current !== session || !session.usable || refreshingSession.current === session) return
    refreshingSession.current = session
    setRefreshing(true)
    try {
      const [nextProjects, nextSessions, nextCatalog] = await Promise.all([
        session.query<RemoteProject[]>('project.list'),
        session.query<SessionSummary[]>('session.list'),
        session.supports('models.list')
          ? session.query<RemoteModelCatalog>('models.list')
          : Promise.resolve(null),
      ])
      if (live.current !== session || !session.usable) return
      setProjects(visibleProjects(nextProjects))
      setSessions(visibleSessions(nextSessions))
      setCatalog(nextCatalog)
      setLastSyncedAt(Date.now())
      setError(null)
    } catch (failure) {
      if (
        live.current === session &&
        session.state !== 'revoked' &&
        session.state !== 'unknown-device'
      )
        setError(failure instanceof Error ? failure.message : 'The computer did not answer.')
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
    const controller = new AbortController()
    const cancelRetry = (): void => {
      if (retry !== null) clearTimeout(retry)
      retry = null
    }
    const scheduleReconnect = (): void => {
      if (cancelled || retry !== null) return
      retry = setTimeout(() => {
        retry = null
        void connect()
      }, RECONNECT_DELAY_MS)
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
        setComputers((saved) => saved.map((computer) => computer.origin === origin
          ? { ...computer, status: state, lastConnectedAt: state === 'connected' ? Date.now() : computer.lastConnectedAt }
          : computer))
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
    // MobileSession bounds each connection cycle; an exhausted cycle stays unreachable.
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
        try {
          const state = await session.connect(controller.signal)
          if (cancelled || live.current !== session) return
          refused = !canReconnect(state)
          connected = state === 'connected'
          setConnection(state)
          setCapabilities(session.usable ? session.capabilities : [])
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
          }
        }
      })()
      return connecting
    }
    connectionOwner.current = { session, connect: () => connect('manual'), controller, pairing: null }
    void connect('initial')
    const visible = (): void => {
      if (document.visibilityState === 'visible') void connect()
    }
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshWith(session)
    }, 15000)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    return () => {
      cancelled = true
      controller.abort()
      session.disconnect()
      cancelRetry()
      if (live.current === session) live.current = null
      if (connectionOwner.current?.session === session) connectionOwner.current = null
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', visible)
    }
  }, [origin, keyring, refreshWith, managedComputerId])
  const refresh = useCallback(async (): Promise<void> => {
    if (linked !== null) await refreshWith(linked)
  }, [linked, refreshWith])
  const pair = useCallback(
    async (invitationId: string, displayName: string): Promise<void> => {
      if (linked === null) throw new Error('Choose a computer first.')
      const owner = connectionOwner.current
      if (owner === null || owner.session !== linked) throw new Error('Choose this computer again before pairing.')
      if (owner.pairing !== null) throw new Error('A pairing attempt is already waiting for this computer.')
      const pending = linked.pair(invitationId, displayName, owner.controller.signal)
      owner.pairing = pending
      try { await pending }
      finally { if (owner.pairing === pending) owner.pairing = null }
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
    const selected = origin
    // Close the visible workspace before deleting its credential. Late reads cannot repaint it.
    abandonConnection()
    setLinked(null)
    setOrigin(null)
    setManagedComputerId(null)
    setConnection('unpaired')
    // The local store generation rejects delayed pairing writes; no remote wait is needed.
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
  }, [keyring, origin, abandonConnection])
  const rememberOrigin = useCallback((next: string): void => {
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
    history.replaceState(null, '', routeUrl({ destination: 'home', sessionId: null }, location.href))
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
  }, [origin, computers, navigateTo, abandonConnection])
  const chooseComputer = useCallback(
    (computerId: string, next: string): void => {
      if (!IS_CONNECT_BUILD) throw new Error('This build uses your own private network.')
      setManagedComputerId(computerId)
      setComputers((saved) => saveComputer(saved, next, undefined, computerId))
      rememberOrigin(next)
    },
    [rememberOrigin],
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
  const switchComputer = useCallback((next: string): void => {
    const computer = computers.find((entry) => entry.origin === next)
    if (IS_CONNECT_BUILD) {
      if (computer?.managedComputerId === undefined) throw new Error('Choose this computer from Ari Connect.')
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
  }, [computers, chooseComputer, origin, reconnect, rememberOrigin, changeComputer, navigateTo])
  const addComputer = useCallback((address: string, name?: string): void => {
    if (IS_CONNECT_BUILD) throw new Error('Choose computers from your approved Ari Connect account.')
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
  }, [computers, origin, reconnect, rememberOrigin, changeComputer, navigateTo])
  const renameComputer = useCallback((selected: string, name: string): void => {
    if (!name.trim()) throw new Error('Give this computer a name.')
    setComputers((saved) => saved.map((computer) => computer.origin === selected
      ? { ...computer, name: name.trim().slice(0, 80) } : computer))
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
