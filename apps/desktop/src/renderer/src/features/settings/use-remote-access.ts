import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@ari/contracts/project'
import type { RemoteConnectState, RemoteState, TailscaleState } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { formatUnknownError } from '@ari/shared/result'
import { rpc } from '../../lib/rpc'

const log = createLogger('settings:remote')

/** Loads remote setup facts and serializes mutations with visible failure states. */
export function useRemoteAccess() {
  const [remote, setRemote] = useState<RemoteState | null>(null)
  const [tailscale, setTailscale] = useState<TailscaleState | null>(null)
  const [connect, setConnect] = useState<RemoteConnectState | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const locked = useRef(false)
  const live = useRef(true)

  const run = useCallback((label: string, operation: () => Promise<void>): void => {
    if (locked.current) return
    locked.current = true
    setBusy(label)
    setError(null)
    void operation()
      .catch((cause: unknown) => {
        log.warn('remote access operation failed', { label, error: cause })
        if (live.current) setError(`${label} failed. ${formatUnknownError(cause)}`)
      })
      .finally(() => {
        locked.current = false
        if (live.current) setBusy(null)
      })
  }, [])

  const refresh = useCallback(() => {
    run('Connection checks', async () => {
      const results = await Promise.allSettled([
        rpc.invoke('remote.status').then((state) => {
          if (live.current) setRemote(state)
        }),
        rpc.invoke('remote.tailscale.status').then((state) => {
          if (live.current) setTailscale(state)
        }),
        rpc.invoke('project.list').then((list) => {
          if (live.current) setProjects(list)
        }),
        rpc.invoke('remote.connect.status').then((state) => {
          if (live.current) setConnect(state)
        }),
      ])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
  }, [run])

  useEffect(() => {
    live.current = true
    refresh()
    const unsubscribe = rpc.subscribe('remote.updates', {}, (payload) => {
      if (live.current) setRemote(payload as RemoteState)
    })
    return () => {
      live.current = false
      unsubscribe()
    }
  }, [refresh])

  const phase = connect?.phase
  useEffect(() => {
    if (
      phase === undefined ||
      !['awaiting-approval', 'provisioning', 'connecting', 'ready'].includes(phase)
    )
      return
    const timer = setInterval(
      () =>
        run('Connect status', async () => {
          const state = await rpc.invoke('remote.connect.status')
          if (live.current) setConnect(state)
          const remoteState = await rpc.invoke('remote.status')
          if (live.current) setRemote(remoteState)
        }),
      5000,
    )
    return () => clearInterval(timer)
  }, [phase, run])

  return {
    remote,
    tailscale,
    connect,
    projects,
    error,
    busy,
    run,
    refresh,
    setRemote,
    setTailscale,
    setConnect,
  }
}
