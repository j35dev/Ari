import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultSettings, settingsSchema } from '@ari/contracts/settings'
import type { Settings } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:settings')

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

  constructor(options: SettingsStoreOptions) {
    this.#path = join(options.dir, 'settings.json')
  }

  get current(): Settings {
    return this.#current
  }

  async load(): Promise<Settings> {
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

  /** Shallow-per-section merge update, persisted atomically. */
  async update(patch: {
    appearance?: Partial<Settings['appearance']>
    sessions?: Partial<Settings['sessions']>
    permissions?: Partial<Settings['permissions']>
  }): Promise<Settings> {
    const next: Settings = {
      version: 1,
      appearance: { ...this.#current.appearance, ...patch.appearance },
      sessions: { ...this.#current.sessions, ...patch.sessions },
      permissions: { ...this.#current.permissions, ...patch.permissions },
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
