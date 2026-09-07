import { existsSync } from 'node:fs'
import type { Session } from '@ari/contracts/session'

/** Resolves the actual session cwd, including explicitly shared parent workspaces. */
export async function resolveSessionWorkspace(
  session: Session,
  projectPath: (id: string) => Promise<string | null>,
  sessionById: (id: string) => Promise<Session | null>,
): Promise<string | null> {
  const seen = new Set<string>()
  let current = session
  while (true) {
    if (seen.has(current.id) || current.projectId !== session.projectId) return null
    seen.add(current.id)
    if (current.workspace?.kind === 'managed-worktree') {
      return existsSync(current.workspace.path) ? current.workspace.path : null
    }
    if (!current.parentSessionId) return projectPath(current.projectId)
    const parent = await sessionById(current.parentSessionId)
    if (!parent) return null
    current = parent
  }
}
