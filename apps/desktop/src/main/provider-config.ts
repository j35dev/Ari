import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { providerConfigDir, providerConfigFile, providerConfigFiles } from '@ari/providers/config-files'
import type { ProviderConfigFile } from '@ari/providers/config-files'
import { writeTextFile } from './fs-write'

const log = createLogger('desktop:provider-config')

/**
 * Reads and writes the agents' own configuration files on the user's behalf.
 *
 * Two rules make this safe to expose. The renderer never sends a path — only a
 * kind and a file id, resolved here against the manifest — and every write is
 * jailed to that kind's own config directory by the same symlink-resolving
 * `writeTextFile` the engine tools use. So the surface can only ever touch the
 * handful of files Ari has declared for an agent it detected.
 *
 * Ari does not understand these formats and does not try to: content is stored
 * verbatim. The one exception is a JSON syntax check before saving, because an
 * unparseable settings file is how you silently lose an agent's config.
 */

/** Read cap: these are settings files, not documents. */
const READ_MAX_BYTES = 512 * 1024

export async function listProviderConfigFiles(
  kind: DriverKind,
): Promise<RpcResults['providers.configFiles']> {
  const dir = providerConfigDir(kind)
  const files = await Promise.all(
    providerConfigFiles(kind).map(async (file) => {
      const info = await stat(file.path).catch(() => null)
      return {
        id: file.id,
        label: file.label,
        path: file.path,
        format: file.format,
        description: file.description,
        exists: info !== null && info.isFile(),
        size: info !== null && info.isFile() ? info.size : 0,
      }
    }),
  )
  return { dir, files }
}

export async function readProviderConfig(
  kind: DriverKind,
  fileId: string,
): Promise<RpcResults['providers.readConfig']> {
  const file = requireFile(kind, fileId)
  const raw = await readFile(file.path, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (raw === null) return { content: '', exists: false, path: file.path, truncated: false }
  const truncated = Buffer.byteLength(raw, 'utf8') > READ_MAX_BYTES
  return {
    content: truncated ? raw.slice(0, READ_MAX_BYTES) : raw,
    exists: true,
    path: file.path,
    truncated,
  }
}

export async function writeProviderConfig(
  kind: DriverKind,
  fileId: string,
  content: string,
): Promise<RpcResults['providers.writeConfig']> {
  let file: ProviderConfigFile
  try {
    file = requireFile(kind, fileId)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const invalid = formatComplaint(file, content)
  if (invalid !== null) return { ok: false, error: invalid }

  try {
    // The agent may never have written its config dir (pi only creates
    // SYSTEM.md when you do), so saving has to be able to establish it.
    await mkdir(dirname(file.path), { recursive: true })
    const bytesWritten = await writeTextFile({ path: file.path, content }, [dirname(file.path)])
    log.info('provider config saved', { kind, fileId, bytesWritten })
    return { ok: true, bytesWritten }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('provider config save failed', { kind, fileId, error: message })
    return { ok: false, error: message }
  }
}

/**
 * Rejects a payload the agent could not load. Only JSON is checked — Ari ships
 * no TOML parser, and refusing to save markdown would be absurd — so this is a
 * guard against the one silent-loss case, not a schema validator.
 */
function formatComplaint(file: ProviderConfigFile, content: string): string | null {
  if (file.format !== 'json') return null
  if (content.trim().length === 0) return null
  try {
    JSON.parse(content)
    return null
  } catch (error) {
    return `${file.label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

function requireFile(kind: DriverKind, fileId: string): ProviderConfigFile {
  const file = providerConfigFile(kind, fileId)
  if (file === null) throw new Error(`no config file '${fileId}' for ${kind}`)
  return file
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT'
}
