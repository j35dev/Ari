import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ScriptInfo {
  name: string
  command: string
}

export interface ScriptsListResult {
  scripts: ScriptInfo[]
}

/**
 * Run scripts (M21.3): npm-style `scripts` from the folder's package.json.
 * A missing or unreadable package.json is a normal outcome — an empty list,
 * never a thrown error.
 */
export async function listScripts(folderPath: string): Promise<ScriptsListResult> {
  try {
    const raw = await readFile(join(folderPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { scripts?: unknown }
    if (pkg.scripts === null || typeof pkg.scripts !== 'object') return { scripts: [] }
    const scripts: ScriptInfo[] = []
    for (const [name, command] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof command === 'string' && name.length > 0) {
        scripts.push({ name, command })
      }
    }
    return { scripts }
  } catch {
    return { scripts: [] }
  }
}
