import type { EffortCatalog } from '../acp/thought'
import type { CatalogModel } from '../catalogs'
import { AppServerConnection } from './appserver-connection'

interface CatalogTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  shutdown(): Promise<void>
}

interface ModelEntry {
  id?: unknown
  model?: unknown
  displayName?: unknown
  hidden?: unknown
  isDefault?: unknown
  defaultReasoningEffort?: unknown
  supportedReasoningEfforts?: unknown
}

interface ModelListResult {
  data?: unknown
  nextCursor?: unknown
}

export interface CodexModelCatalog {
  models: CatalogModel[]
  efforts: EffortCatalog
}

/** Environment for the spawned CLI; the caller's enriched PATH, when it has one. */
export type ProbeEnvironment = Record<string, string | undefined>

export type CatalogTransportFactory = (
  binaryPath: string,
  cwd: string,
  env: ProbeEnvironment | undefined,
) => CatalogTransport

export interface CodexCatalogProbeOptions {
  /**
   * Process environment for the spawned CLI. Detection searches the enriched
   * PATH, so the probe must run with it too: a GUI-launched app inherits a
   * thin PATH, and a shim found there is only runnable if the child can also
   * resolve the runtime it shells out to. Omit to inherit the host env.
   */
  env?: ProbeEnvironment
  /** Transport seam; defaults to a real `codex app-server` subprocess. */
  start?: CatalogTransportFactory
}

const startTransport: CatalogTransportFactory = (binaryPath, cwd, env) =>
  AppServerConnection.start({
    binaryPath,
    cwd,
    // An empty env object would strip PATH from the child entirely; omit the
    // key so an absent override inherits the host environment instead.
    ...(env !== undefined ? { env } : {}),
  })

/** Reads the picker-visible catalog directly from the user's installed Codex CLI. */
export async function probeCodexModelCatalog(
  binaryPath: string,
  cwd: string,
  options: CodexCatalogProbeOptions = {},
): Promise<CodexModelCatalog> {
  const connection = (options.start ?? startTransport)(binaryPath, cwd, options.env)
  try {
    await connection.request(
      'initialize',
      { clientInfo: { name: 'ari', version: '0.1.0' }, capabilities: {} },
      15_000,
    )

    const entries: ModelEntry[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = (await connection.request(
        'model/list',
        { limit: 100, includeHidden: false, ...(cursor === null ? {} : { cursor }) },
        15_000,
      )) as ModelListResult | null
      if (Array.isArray(result?.data)) entries.push(...(result.data as ModelEntry[]))
      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : null
      if (next === null || seenCursors.has(next)) break
      seenCursors.add(next)
      cursor = next
    }

    const models: CatalogModel[] = []
    const seenModels = new Set<string>()
    for (const entry of entries) {
      if (entry.hidden === true) continue
      const id = typeof entry.model === 'string' ? entry.model : entry.id
      if (typeof id !== 'string' || id.length === 0 || seenModels.has(id)) continue
      seenModels.add(id)
      models.push({
        id,
        label:
          typeof entry.displayName === 'string' && entry.displayName.length > 0
            ? entry.displayName
            : id,
      })
    }

    const effortEntry = entries.find((entry) => entry.isDefault === true) ?? entries[0]
    const efforts = effortCatalog(effortEntry)
    return { models, efforts }
  } finally {
    await connection.shutdown()
  }
}

function effortCatalog(entry: ModelEntry | undefined): EffortCatalog {
  const raw = Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : []
  const options = raw.flatMap((value) => {
    if (value === null || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const id = record['reasoningEffort']
    if (typeof id !== 'string' || id.length === 0) return []
    return [
      {
        id,
        label: effortLabel(id),
        ...(typeof record['description'] === 'string'
          ? { description: record['description'] }
          : {}),
      },
    ]
  })
  const current = entry?.defaultReasoningEffort
  return {
    currentId:
      typeof current === 'string' && options.some((option) => option.id === current)
        ? current
        : null,
    options,
  }
}

function effortLabel(id: string): string {
  if (id === 'xhigh') return 'Extra high'
  return id.charAt(0).toUpperCase() + id.slice(1)
}
