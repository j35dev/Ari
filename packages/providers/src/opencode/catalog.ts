import { basename } from 'node:path'
import type { EffortCatalog } from '../acp/thought'
import type { CatalogModel } from '../catalogs'
import { opencodeServerPool } from './opencode-sdk-driver'
import type { OpencodeServerPool } from './server'
import type { OpencodeGeneration } from './version'
import { classifyOpencodeVersion } from './version'

/**
 * Models, effort levels and the default model, read from the shared OpenCode
 * server instead of a throwaway ACP session. Rows keep the ids OpenCode's ACP
 * adapter used (`provider/model`, variants as efforts), so sessions saved
 * under ACP resolve to the same rows.
 */
export interface OpencodeCatalog {
  models: CatalogModel[]
  efforts: EffortCatalog
  defaultModelId: string | null
}

export async function readOpencodeCatalog(input: {
  binary: string
  generation: OpencodeGeneration
  env: Record<string, string | undefined>
  directory: string
  pool?: OpencodeServerPool
}): Promise<OpencodeCatalog> {
  const pool = input.pool ?? opencodeServerPool
  const server = await pool.acquire(
    { binary: input.binary, generation: input.generation, env: input.env },
    { anyEnvironment: true },
  )
  try {
    const catalog = await server.wire.catalog(input.directory)
    const fallback = catalog.models.find((model) => model.id === catalog.defaultModelId)
    return {
      models: catalog.models,
      efforts: { currentId: 'default', options: fallback?.efforts ?? [] },
      defaultModelId: catalog.defaultModelId,
    }
  } finally {
    pool.release(server)
  }
}

/** How the providers page names the connection, e.g. `OpenCode 2 server`. */
export function opencodeTransportLabel(
  version: string | null,
  binaryPath: string | null = null,
): string {
  return opencodeGeneration(version, binaryPath) === 'v2' ? 'OpenCode 2 server' : 'OpenCode server'
}

/**
 * The generation a detection's `--version` names. When the probe did not
 * answer, an `opencode2` launcher is OpenCode 2 and anything else is classic.
 */
export function opencodeGeneration(
  version: string | null,
  binaryPath: string | null = null,
): OpencodeGeneration {
  const known = classifyOpencodeVersion(version)?.generation
  if (known) return known
  return binaryPath !== null && /^opencode2(?:\.|$)/i.test(basename(binaryPath)) ? 'v2' : 'v1'
}
