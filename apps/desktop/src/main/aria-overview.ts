import { isHelmSession } from '@ari/contracts/helm'
import { ariaOverview, type AriaOverview } from '@ari/engine/aria-overview'
import type { SessionStore } from '@ari/engine/session-store'

export async function queryAriaOverview(
  store: Pick<SessionStore, 'load' | 'listSessions'>,
  projects: readonly { projectId: string; name: string }[],
  sessionId: string,
): Promise<AriaOverview> {
  const aria = await store.load(sessionId)
  if (!isHelmSession(aria.session)) throw new Error('Aria overview requires an Aria session')
  const names = new Map(projects.map((project) => [project.projectId, project.name]))
  return ariaOverview(
    {
      rows: await store.listSessions(),
      load: (id) => store.load(id),
      projectName: (id) => names.get(id) ?? null,
    },
    aria,
  )
}
