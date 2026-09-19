import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { RemoteProject } from '@ari/contracts/remote'
import type { SessionSummary } from '@ari/contracts/rpc'
import { DeviceKeyring, type DeviceStore } from './device-key'
import { GatewayClient } from './gateway-client'
import { MobileSession, type ConnectionState } from './session'

/**
 * Everything the screens share: which desktop this phone is paired with, the
 * state of that link, and the two lists every destination starts from.
 *
 * One provider rather than a store library, because the interesting part of
 * this app is not the data — it is what the user may do with it, which the
 * gateway's capability list and the device's project grants decide.
 */

/** Where the desktop's address is remembered between launches. */
const ORIGIN_KEY = 'ari.remote.origin'

export interface AppValue {
  /** The desktop this phone talks to, once one is known. */
  origin: string | null
  /**
   * True once the first connection attempt has settled. Before that the app
   * is still deciding between "paired" and "never paired", and must show
   * neither the shell nor the pairing screen.
   */
  booted: boolean
  connection: ConnectionState
  /**
   * The live session, or null until the device store has been read. Screens
   * treat null as "not usable yet" rather than guessing at capabilities.
   */
  session: MobileSession | null
  /** Operations the desktop actually serves, from its own discovery answer. */
  capabilities: readonly string[]
  projects: RemoteProject[]
  sessions: SessionSummary[]
  /** Set when something could not be refreshed, in words a user can act on. */
  error: string | null
  refreshing: boolean
  refresh: () => Promise<void>
  /** Pairs with an invitation id read from a link or a QR code. */
  pair: (invitationId: string, displayName: string) => Promise<void>
  /** Runs the connection attempt again, for the retry control. */
  reconnect: () => Promise<void>
  /** Forgets this browser's device key and the remembered address. */
  forget: () => Promise<void>
  /** Used when a pairing link names a desktop this browser has not stored. */
  rememberOrigin: (origin: string) => void
}

const AppContext = createContext<AppValue | null>(null)

export function useApp(): AppValue {
  const value = useContext(AppContext)
  if (value === null) throw new Error('useApp outside its provider')
  return value
}

/**
 * Reads the invitation out of the URL fragment and clears it immediately.
 *
 * A fragment because it never leaves the device: the desktop, a managed tunnel
 * and Cloudflare all see the path, and an invitation id in a path would be
 * written into three sets of logs.
 */
export function takeInvitationFromUrl(href: string): string | null {
  const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
  if (fragment.length === 0) return null
  const invitationId = new URLSearchParams(fragment).get('pair')
  if (invitationId === null) return null
  history.replaceState(null, '', href.split('#')[0] ?? '/')
  return invitationId
}

/** Where a phone should look for its desktop, before any link has been opened. */
function initialOrigin(): string | null {
  const remembered = localStorage.getItem(ORIGIN_KEY)
  if (remembered !== null) return remembered
  // A page served by the gateway is talking to its own origin — that is what
  // Tailscale mode is: one address for the app and the API behind it.
  return location.protocol.startsWith('http') ? location.origin : null
}

export function AppProvider({ store, children }: { store: DeviceStore; children: ReactNode }): ReactNode {
  const [origin, setOrigin] = useState<string | null>(initialOrigin)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [booted, setBooted] = useState(false)
  const [capabilities, setCapabilities] = useState<readonly string[]>([])
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** Rebuilt whenever the desktop changes: a token belongs to one origin. */
  const [linked, setLinked] = useState<{ session: MobileSession; keyring: DeviceKeyring } | null>(null)

  const keyring = useMemo(() => new DeviceKeyring(store), [store])

  useEffect(() => {
    // No address and nothing to decide: the pairing screen owns this case.
    if (origin === null) {
      setBooted(true)
      return
    }
    let cancelled = false
    const client = new GatewayClient({ origin })
    const session = new MobileSession({ keyring, client, onState: setConnection })

    void (async () => {
      await keyring.load()
      const next = await session.connect()
      if (cancelled) return
      setLinked({ session, keyring })
      setConnection(next)
      setCapabilities(session.capabilities)
      if (next === 'connected') await refreshWith(session)
      setBooted(true)
    })()

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void session.connect()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
    // `refreshWith` is stable; `keyring` only changes with the store.
  }, [origin, keyring])

  const refreshWith = useCallback(async (session: MobileSession) => {
    if (!session.usable) return
    setRefreshing(true)
    try {
      const [projectList, sessionList] = await Promise.all([
        session.query<RemoteProject[]>('project.list'),
        session.query<SessionSummary[]>('session.list'),
      ])
      setProjects(projectList)
      setSessions(sessionList)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'the desktop did not answer')
    } finally {
      setRefreshing(false)
    }
  }, [])

  const pair = useCallback(
    async (invitationId: string, displayName: string) => {
      if (linked === null) throw new Error('this phone has no desktop address yet')
      await linked.session.pair(invitationId, displayName)
      setConnection('connected')
      setCapabilities(linked.session.capabilities)
      await refreshWith(linked.session)
    },
    [linked, refreshWith],
  )

  const reconnect = useCallback(async () => {
    if (linked === null) return
    const next = await linked.session.connect()
    setConnection(next)
    setCapabilities(linked.session.capabilities)
    if (next === 'connected') await refreshWith(linked.session)
  }, [linked, refreshWith])

  const forget = useCallback(async () => {
    await keyring.forget()
    localStorage.removeItem(ORIGIN_KEY)
    setLinked(null)
    setOrigin(null)
    setConnection('unpaired')
    setCapabilities([])
    setProjects([])
    setSessions([])
  }, [keyring])

  const rememberOrigin = useCallback((next: string) => {
    localStorage.setItem(ORIGIN_KEY, next)
    setOrigin(next)
  }, [])

  const value: AppValue = {
    origin,
    booted,
    connection,
    session: linked?.session ?? null,
    capabilities,
    projects,
    sessions,
    error,
    refreshing,
    refresh: async () => {
      if (linked !== null) await refreshWith(linked.session)
    },
    pair,
    reconnect,
    forget,
    rememberOrigin,
  }
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
