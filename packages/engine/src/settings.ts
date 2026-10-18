import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultSettings, settingsSchema } from '@ari/contracts/settings'
import type { CliKind, Settings, SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:settings')

/** One level deeper than the other sections: a patch names a provider, then its fields. */
function mergeConnections(
  current: Settings['providers'],
  patch: SettingsUpdate['providers'],
): Settings['providers'] {
  const next = { ...current }
  for (const kind of Object.keys(patch ?? {}) as CliKind[]) {
    const fields = patch?.[kind]
    if (fields === undefined) continue
    next[kind] = {
      enabled: fields.enabled ?? current[kind].enabled,
      binaryPath: fields.binaryPath ?? current[kind].binaryPath,
    }
  }
  return next
}

interface SettingsPatch {
  delegation?: Partial<Settings['delegation']>
  appearance?: Partial<Settings['appearance']>
  sessions?: Partial<Settings['sessions']>
  providers?: SettingsUpdate['providers']
  notifications?: Partial<Settings['notifications']>
  permissions?: Partial<Settings['permissions']>
  remote?: Partial<Settings['remote']>
  window?: Settings['window']
}

export interface SettingsStoreOptions {
  /** Directory holding settings.json (typically <userData>). */
  dir: string
}

/**
 * JSON settings file with atomic writes and schema-versioned defaults.
 * Unknown fields are dropped on load; a corrupt file falls back to defaults
 * rather than blocking boot.
 */
export class SettingsStore {
  readonly #path: string
  #current: Settings = defaultSettings
  #writes: Promise<unknown> = Promise.resolve()

  constructor(options: SettingsStoreOptions) {
    this.#path = join(options.dir, 'settings.json')
  }

  get current(): Settings {
    return this.#current
  }

  /**
   * Reads the file into memory. Queued behind any update in flight: a read
   * that began before a save finished would otherwise put the older contents
   * back in memory, and the next update would build on them.
   */
  load(): Promise<Settings> {
    return this.#queue(() => this.#read())
  }

  #queue(task: () => Promise<Settings>): Promise<Settings> {
    const done = this.#writes.then(task)
    this.#writes = done.catch(() => undefined)
    return done
  }

  async #read(): Promise<Settings> {
    let raw: string
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch {
      // First boot — persist defaults so the file exists for users to inspect.
      await this.save(defaultSettings)
      this.#current = defaultSettings
      return this.#current
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.#current = settingsSchema.parse(parsed)
    } catch (e) {
      log.warn('settings corrupt or invalid; using defaults', { error: String(e) })
      this.#current = defaultSettings
      await this.save(defaultSettings)
    }
    return this.#current
  }

  /**
   * Shallow-per-section merge update, persisted atomically. Updates apply one
   * at a time, each on top of the last: two that arrive together (two switches
   * flipped, or a toggle during a window move) both land, where merging each
   * onto the same snapshot would let the later one undo the earlier.
   */
  update(patch: SettingsPatch): Promise<Settings> {
    return this.#queue(() => this.#apply(patch))
  }

  async #apply(patch: SettingsPatch): Promise<Settings> {
    const next: Settings = {
      delegation: { ...this.#current.delegation, ...patch.delegation },
      version: 1,
      appearance: { ...this.#current.appearance, ...patch.appearance },
      sessions: { ...this.#current.sessions, ...patch.sessions },
      providers: mergeConnections(this.#current.providers, patch.providers),
      notifications: { ...this.#current.notifications, ...patch.notifications },
      permissions: { ...this.#current.permissions, ...patch.permissions },
      remote: { ...this.#current.remote, ...patch.remote },
      window: patch.window !== undefined ? patch.window : this.#current.window,
    }
    const validated = settingsSchema.parse(next)
    await this.save(validated)
    this.#current = validated
    return this.#current
  }

  async save(settings: Settings): Promise<void> {
    await mkdir(join(this.#path, '..'), { recursive: true })
    const tmp = `${this.#path}.tmp`
    await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    // Atomic on same-volume rename; readers never see a torn file.
    await rename(tmp, this.#path)
  }
}
