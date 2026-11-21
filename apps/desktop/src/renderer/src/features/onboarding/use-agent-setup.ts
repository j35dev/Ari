import { useCallback, useEffect, useRef, useState } from 'react'
import { providerEnabledByDefault } from '@ari/contracts/settings'
import type { RpcResults } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { useProviderAuth } from '../providers/use-provider-auth'
import { useProviderInstalls, type InstallState } from '../providers/use-provider-installs'
import { usable, type CliAgent, type Detection } from './agent-catalog'

const log = createLogger('onboarding:agents')

export type InstallPlan = NonNullable<RpcResults['providers.plan']>

/** Where one agent stands in setup, in the order the user meets each state. */
export type AgentStage =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'installing'; install: InstallState }
  | { kind: 'failed'; reason: string; details: string }
  | { kind: 'signing-in' }
  | { kind: 'needs-sign-in'; note: string | null }
  | { kind: 'ready' }

export interface SetupTerminal {
  id: string
  cwd: string
  kind: CliAgent
}

/**
 * Detection, installs and sign-in for setup, owned by the wizard so an install
 * keeps its progress when the user steps back and forth. Installs run through
 * the shared provider update queue and only ever start from {@link install}.
 */
export function useAgentSetup() {
  const [detections, setDetections] = useState<Detection[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [plans, setPlans] = useState<Partial<Record<CliAgent, InstallPlan | null>>>({})
  const [terminal, setTerminal] = useState<SetupTerminal | null>(null)
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const [notes, setNotes] = useState<Partial<Record<CliAgent, string>>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  /** Installs the user cancelled: their settle is a return to the start, not a failure. */
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set())
  const alive = useRef(true)
  const generation = useRef(0)
  /** Kinds installed from setup: success moves them straight on to sign-in. */
  const continueAfterInstall = useRef(new Set<CliAgent>())
  const detectionsRef = useRef(detections)
  detectionsRef.current = detections

  const receive = useCallback((rows: Detection[]) => {
    generation.current++
    setScanning(false)
    setDetections(rows)
  }, [])
  const { installs, start, cancel } = useProviderInstalls(receive)
  const { auth, check, loginsFor, dismiss } = useProviderAuth()

  const scan = useCallback(async (fresh = false): Promise<Detection[] | null> => {
    const mine = ++generation.current
    setScanning(true)
    setScanError(null)
    try {
      const rows = await rpc.invoke(fresh ? 'providers.rescan' : 'providers.detect')
      if (alive.current && mine === generation.current) setDetections(rows)
      return rows
    } catch (error) {
      log.warn('agent detection failed', error)
      if (alive.current && mine === generation.current)
        setScanError('Ari could not check for agents. Try again, or set one up later in Settings.')
      return null
    } finally {
      if (alive.current && mine === generation.current) setScanning(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void scan()
    return () => {
      alive.current = false
      generation.current++
    }
  }, [scan])

  useEffect(
    () => () => {
      if (terminal)
        void rpc
          .invoke('terminal.kill', { id: terminal.id })
          .catch((error: unknown) => log.warn('setup terminal cleanup failed', error))
    },
    [terminal],
  )

  const isReady = useCallback(
    (kind: string, rows: readonly Detection[] | null = detectionsRef.current): boolean => {
      const detection = rows?.find((d) => d.kind === kind)
      if (!usable(detection)) return false
      return (
        detection.authStatus === 'authenticated' ||
        confirmed.has(kind) ||
        auth[kind as CliAgent]?.result.status === 'ready'
      )
    },
    [auth, confirmed],
  )

  const markReady = useCallback((kind: CliAgent) => {
    setConfirmed((prev) => new Set(prev).add(kind))
    setNotes((prev) => ({ ...prev, [kind]: undefined }))
  }, [])

  /** Loads the exact install command and whether this computer can run it. */
  const plan = useCallback(async (kind: CliAgent): Promise<InstallPlan | null> => {
    try {
      const next = await rpc.invoke('providers.plan', { kind })
      if (alive.current) setPlans((prev) => ({ ...prev, [kind]: next }))
      return next
    } catch (error) {
      log.warn('install plan failed', { kind, error })
      if (alive.current) setPlans((prev) => ({ ...prev, [kind]: null }))
      return null
    }
  }, [])

  const openTerminal = useCallback(
    async (kind: CliAgent, methodId?: string): Promise<void> => {
      const result = await rpc.invoke(
        'providers.setupTerminal',
        methodId === undefined ? { kind } : { kind, methodId },
      )
      if (!result.ok) throw new Error(result.error)
      if (!alive.current) {
        await rpc.invoke('terminal.kill', { id: result.id })
        return
      }
      dismiss(kind)
      setTerminal({ id: result.id, cwd: result.cwd, kind })
    },
    [dismiss],
  )

  /** The agent's own sign-in, in the setup terminal; skipped when it is already signed in. */
  const signIn = useCallback(
    async (kind: CliAgent): Promise<void> => {
      setActionError(null)
      try {
        if (kind === 'claude' || kind === 'codex') {
          await openTerminal(kind)
          return
        }
        const logins = await loginsFor(kind)
        if (logins[0]) {
          await openTerminal(kind, logins[0].methodId)
          return
        }
        await check(kind)
      } catch (error) {
        log.warn('agent sign-in failed', { kind, error })
        if (alive.current)
          setActionError(error instanceof Error ? error.message : 'Could not open sign-in.')
      }
    },
    [check, loginsFor, openTerminal],
  )

  /** Asks the agent itself before offering a sign-in it may not need. */
  const verifyThenSignIn = useCallback(
    async (kind: CliAgent): Promise<void> => {
      setActionError(null)
      try {
        const result = await rpc.invoke('providers.authProbe', { kind })
        if (result.status === 'ready') {
          markReady(kind)
          return
        }
      } catch (error) {
        log.warn('sign-in check failed', { kind, error })
      }
      await signIn(kind)
    },
    [markReady, signIn],
  )

  /** After the terminal: look again, and only call it ready when the agent agrees. */
  const finishSignIn = useCallback(
    async (kind: CliAgent): Promise<void> => {
      setTerminal(null)
      const rows = await scan(true)
      if (rows?.find((d) => d.kind === kind)?.authStatus === 'authenticated') {
        markReady(kind)
        return
      }
      try {
        const result = await rpc.invoke('providers.authProbe', { kind })
        if (result.status === 'ready') markReady(kind)
        else
          setNotes((prev) => ({
            ...prev,
            [kind]:
              result.status === 'auth-required'
                ? 'Not signed in yet. Sign in again to finish.'
                : result.reason,
          }))
      } catch {
        setNotes((prev) => ({ ...prev, [kind]: 'Ari could not confirm the sign-in. Try again.' }))
      }
    },
    [markReady, scan],
  )

  const install = useCallback(
    async (kind: CliAgent): Promise<void> => {
      setActionError(null)
      try {
        const current = detectionsRef.current?.find((d) => d.kind === kind)
        // Off-by-default agents detect as absent until switched on, so an
        // install would never verify. Turning one on is what installing it means.
        if (current?.enabled === false || !providerEnabledByDefault(kind))
          await rpc.invoke('settings.update', { providers: { [kind]: { enabled: true } } })
        const next = await plan(kind)
        if (next === null) throw new Error('Ari has no installer for this agent on this computer.')
        if (next.prerequisite) return
        setCancelled((prev) => {
          const rest = new Set(prev)
          rest.delete(kind)
          return rest
        })
        continueAfterInstall.current.add(kind)
        await start(kind, 'install')
      } catch (error) {
        continueAfterInstall.current.delete(kind)
        log.warn('agent install failed to start', { kind, error })
        if (alive.current)
          setActionError(error instanceof Error ? error.message : 'Could not start the install.')
      }
    },
    [plan, start],
  )

  // A verified install moves straight on to the agent's own sign-in.
  useEffect(() => {
    for (const kind of continueAfterInstall.current) {
      const outcome = installs[kind]?.outcome
      if (outcome == null) continue
      continueAfterInstall.current.delete(kind)
      if (!outcome.ok) continue
      void scan().then((rows) => {
        if (!alive.current) return
        if (rows !== null && isReady(kind, rows)) markReady(kind)
        else void signIn(kind)
      })
    }
  }, [installs, isReady, markReady, scan, signIn])

  const stageOf = (kind: CliAgent): AgentStage => {
    const install = installs[kind]
    if (install && install.outcome === null) return { kind: 'installing', install }
    if (install?.outcome?.ok === false && !cancelled.has(kind))
      return {
        kind: 'failed',
        reason: install.outcome.reason ?? 'The installer stopped before the agent was ready.',
        details: install.details ?? '',
      }
    if (terminal?.kind === kind) return { kind: 'signing-in' }
    if (detections === null) return { kind: 'checking' }
    const detection = detections.find((d) => d.kind === kind)
    if (!usable(detection)) return { kind: 'missing' }
    if (isReady(kind)) return { kind: 'ready' }
    const probe = auth[kind]?.result
    return {
      kind: 'needs-sign-in',
      note: notes[kind] ?? (probe?.status === 'unknown' ? probe.reason : null),
    }
  }

  return {
    detections,
    scanning,
    scanError,
    scan,
    plans,
    plan,
    install,
    cancel: async (kind: CliAgent) => {
      continueAfterInstall.current.delete(kind)
      setCancelled((prev) => new Set(prev).add(kind))
      try {
        await cancel(kind)
      } catch (error) {
        log.warn('install cancel failed', { kind, error })
      }
    },
    terminal,
    closeTerminal: () => setTerminal(null),
    signIn: verifyThenSignIn,
    finishSignIn,
    stageOf,
    isReady,
    /** Agents that became ready during this setup; their check draws itself. */
    justReady: (kind: string) => confirmed.has(kind),
    markReady,
    actionError,
    busy: terminal !== null || Object.values(installs).some((state) => state?.outcome === null),
  }
}

export type AgentSetup = ReturnType<typeof useAgentSetup>
