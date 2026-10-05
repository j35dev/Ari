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
import { GatewayClient } from './gateway-client'
import { MobileSession, type ConnectionState } from './session'
import { IS_CONNECT_BUILD } from './connect'

const ORIGIN_KEY = 'ari.remote.origin'
export interface AppValue {
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
  try {
    const remembered = localStorage.getItem(ORIGIN_KEY)
    if (remembered !== null) return new URL(remembered).origin
  } catch (error) {
    console.warn('Ari could not read the remembered computer', error)
  }
  return location.protocol.startsWith('http') ? location.origin : null
}

/** Each origin owns a separate device key; foregrounding renews authorization and data. */
export function AppProvider({
  store,
  children,
}: {
  store: DeviceStore
  children: ReactNode
}): ReactNode {
  const [origin, setOrigin] = useState<string | null>(initialOrigin)
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
  const refreshingSession = useRef<MobileSession | null>(null)
  const keyring = useMemo(
    () => new DeviceKeyring(origin === null ? store : (store.forOrigin?.(origin) ?? store)),
    [origin, store],
  )
  const refreshWith = useCallback(async (session: MobileSession): Promise<void> => {
    if (!session.usable || refreshingSession.current === session) return
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
      setProjects(nextProjects)
      setSessions(nextSessions)
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
    if (origin === null) {
      live.current = null
      setBooted(true)
      return
    }
    let cancelled = false
    let connecting = false
    const client = new GatewayClient({ origin })
    const session = new MobileSession({
      keyring,
      client,
      ...(managedComputerId === null ? {} : { managedComputerId }),
      onState: (state) => {
        if (cancelled) return
        setConnection(state)
        if (state === 'revoked' || state === 'unknown-device') {
          setCapabilities([])
          setProjects([])
          setSessions([])
          setCatalog(null)
          setLastSyncedAt(null)
          setError(null)
        }
      },
      onPairCode: (code) => {
        if (!cancelled) setPairingCode(code)
      },
    })
    live.current = session
    setLinked(session)
    const connect = async (): Promise<void> => {
      if (connecting || cancelled) return
      connecting = true
      try {
        const state = await session.connect()
        if (cancelled) return
        setConnection(state)
        setCapabilities(session.usable ? session.capabilities : [])
        if (state === 'connected') await refreshWith(session)
      } catch (failure) {
        if (!cancelled) {
          setError(
            failure instanceof Error ? failure.message : 'Could not read this device identity.',
          )
          setConnection('unreachable')
        }
      } finally {
        connecting = false
        if (!cancelled) setBooted(true)
      }
    }
    void connect()
    const visible = (): void => {
      if (
        document.visibilityState === 'visible' &&
        session.state !== 'revoked' &&
        session.state !== 'unknown-device'
      )
        void connect()
    }
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshWith(session)
    }, 15000)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    return () => {
      cancelled = true
      if (live.current === session) live.current = null
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
      await linked.pair(invitationId, displayName)
      setConnection(linked.state)
      setCapabilities(linked.capabilities)
      await refreshWith(linked)
    },
    [linked, refreshWith],
  )
  const reconnect = useCallback(async (): Promise<void> => {
    if (linked === null) return
    const state = await linked.connect()
    setConnection(state)
    setCapabilities(linked.usable ? linked.capabilities : [])
    if (state === 'connected') await refreshWith(linked)
  }, [linked, refreshWith])
  const forget = useCallback(async (): Promise<void> => {
    await keyring.forget()
    try {
      localStorage.removeItem(ORIGIN_KEY)
    } catch (failure) {
      console.warn('Could not forget the saved address', failure)
    }
    setOrigin(null)
    setConnection('unpaired')
    setLinked(null)
  }, [keyring])
  const rememberOrigin = useCallback((next: string): void => {
    const url = new URL(next)
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Use HTTPS for your computer address.')
    try {
      localStorage.setItem(ORIGIN_KEY, url.origin)
    } catch (failure) {
      console.warn('Could not save the computer address', failure)
    }
    setBooted(false)
    setOrigin(url.origin)
  }, [])
  const chooseComputer = useCallback(
    (computerId: string, next: string): void => {
      if (!IS_CONNECT_BUILD) throw new Error('This build uses your own private network.')
      setManagedComputerId(computerId)
      rememberOrigin(next)
    },
    [rememberOrigin],
  )
  const changeComputer = useCallback((): void => {
    setOrigin(null)
    setManagedComputerId(null)
    setBooted(true)
    setConnection('unpaired')
  }, [])
  return (
    <AppContext.Provider
      value={{
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
