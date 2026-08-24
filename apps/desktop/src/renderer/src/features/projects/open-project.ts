import type { Project } from '@ari/contracts/project'
import { rpc } from '../../lib/rpc'

/**
 * Native-picker open flow: ask for a folder, then register + open it. A
 * cancelled picker resolves to null so callers stay a clean no-op (no error,
 * no state churn).
 */
export async function openProjectViaPicker(defaultPath?: string): Promise<Project | null> {
  const { path } = await rpc.invoke('dialog.pickFolder', { defaultPath })
  if (path === null) return null
  return rpc.invoke('project.open', { path })
}
