import type { DriverKind } from '@ari/contracts/common'

interface SessionUpdateDeps {
  list: () => Promise<readonly { id: string; driverKind?: string }[]>
  liveTurn: (id: string) => boolean
  backgroundWork: (id: string) => boolean
  probesBusy: (kind: DriverKind) => boolean
  release: (id: string) => Promise<void | boolean>
}

/** Only processes with neither a turn nor pending background work may be closed. */
export function providerUpdateSessions(deps: SessionUpdateDeps) {
  return {
    busy: async (kind: DriverKind): Promise<boolean | string> => {
      const sessions = (await deps.list()).filter((session) => session.driverKind === kind)
      const background = sessions.filter((session) => deps.backgroundWork(session.id)).length
      if (background > 0)
        return `Waiting for background work in ${background} ${background === 1 ? 'session' : 'sessions'}…`
      return deps.probesBusy(kind) || sessions.some((session) => deps.liveTurn(session.id))
    },
    release: async (kind: DriverKind): Promise<boolean> => {
      for (const session of await deps.list()) {
        if (session.driverKind !== kind) continue
        // Recheck next to each close: background work can arrive during preparation/release.
        if (deps.liveTurn(session.id) || deps.backgroundWork(session.id)) return false
        if ((await deps.release(session.id)) === false) return false
      }
      return true
    },
  }
}
