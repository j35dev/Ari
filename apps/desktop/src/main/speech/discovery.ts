import { readdir, realpath, stat, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import type { SpeechModel } from '@ari/contracts/rpc'
import catalogData from './catalog.json'

export const catalog: Omit<SpeechModel, 'installed'>[] = catalogData
export interface ModelRoot {
  path: string
  source: 'ari' | 'handy' | 'other'
  depth?: number
}

export function handyDataDirectory(platform: string, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32')
    return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'com.pais.handy')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'com.pais.handy')
  return join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'com.pais.handy')
}

export async function modelRoots(own: string): Promise<ModelRoot[]> {
  const home = homedir()
  const handy = handyDataDirectory(process.platform, home, process.env)
  const roots: ModelRoot[] = [
    { path: own, source: 'ari' },
    { path: join(handy, 'models'), source: 'handy' },
    { path: join(handy, 'huggingface', 'hub'), source: 'handy', depth: 4 },
    {
      path:
        process.env['HF_HUB_CACHE'] ??
        process.env['HUGGINGFACE_HUB_CACHE'] ??
        join(process.env['HF_HOME'] ?? join(home, '.cache', 'huggingface'), 'hub'),
      source: 'other',
      depth: 4,
    },
  ]
  // Portable installs on PATH can be found without probing entire drives.
  for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, 'portable'))
      await access(join(directory, process.platform === 'win32' ? 'Handy.exe' : 'handy'))
      roots.push({ path: join(directory, 'Data', 'models'), source: 'handy' })
      roots.push({ path: join(directory, 'Data', 'huggingface', 'hub'), source: 'handy', depth: 4 })
    } catch {
      /* Most PATH entries do not contain Handy. */
    }
  }
  return roots
}

export async function discoverModels(roots: ModelRoot[]): Promise<SpeechModel[]> {
  const models: SpeechModel[] = catalog.map((entry) => ({ ...entry, installed: false }))
  const seen = new Set<string>()
  let visited = 0
  const walk = async (
    directory: string,
    source: ModelRoot['source'],
    depth: number,
  ): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++visited > 10_000) return
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (source === 'ari' && entry.isFile() && entry.name.endsWith('.gguf.partial')) {
        const model = models.find((model) => `${model.filename}.partial` === entry.name)
        const info = await stat(path).catch(() => null)
        if (model && info?.size) model.partial = { size: info.size, updatedAt: info.mtimeMs }
        continue
      }
      if (entry.isDirectory()) {
        if (depth > 0) await walk(path, source, depth - 1)
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.gguf')) continue
      const info = await stat(path).catch(() => null)
      if (!info?.isFile() || info.size === 0) continue
      const resolved = await realpath(path).catch(() => path)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      const known = models.find(
        (model) => model.filename === entry.name && model.repository !== null,
      )
      if (known && !known.installed) {
        // Catalog downloads are fixed-size; incomplete legacy files must not arm the mic.
        if (known.size !== info.size) continue
        known.installed = { path, source }
      } else {
        models.push({
          id: `local:${path}`,
          name: entry.name,
          description: 'Local GGUF model',
          languages: [],
          filename: entry.name,
          size: info.size,
          sha256: null,
          repository: null,
          revision: null,
          installed: { path, source },
        })
      }
    }
  }
  for (const root of roots) await walk(root.path, root.source, root.depth ?? 0)
  return models
}
