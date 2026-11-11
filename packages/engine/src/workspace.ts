import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isWithinRoot } from '@ari/shared/paths'
import type { Session } from '@ari/contracts/session'

/** Compare physical folders, including aliases and nested working folders. */
export async function workspacesOverlap(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    realpath(a).catch(() => a),
    realpath(b).catch(() => b),
  ])
  return isWithinRoot(left, right) || isWithinRoot(right, left)
}

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
