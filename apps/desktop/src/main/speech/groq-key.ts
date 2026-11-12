import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export class GroqKeyStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string) {}

  private available(): boolean {
    return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  }
  async read(): Promise<string | null> {
    await this.writes
    if (!this.available()) return null
    try { return safeStorage.decryptString(await readFile(this.path)) }
    catch { return null }
  }
  async status(): Promise<{ configured: boolean; encryptionAvailable: boolean }> {
    return { configured: Boolean(await this.read()), encryptionAvailable: this.available() }
  }
  set(key: string | null): Promise<void> {
    const task = this.writes.then(async () => {
      if (key === null) { await rm(this.path, { force: true }); return }
      if (!this.available()) throw new Error('Secure key storage is unavailable on this computer. Use local speech.')
      await mkdir(dirname(this.path), { recursive: true })
      const encrypted = safeStorage.encryptString(key.trim())
      await writeFile(`${this.path}.tmp`, encrypted, { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    })
    this.writes = task.catch(() => undefined)
    return task
  }
}
