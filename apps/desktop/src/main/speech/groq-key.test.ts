// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const secure = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => secure.available,
  getSelectedStorageBackend: () => 'test',
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
} }))
import { GroqKeyStore } from './groq-key'
let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); secure.available = true })
it('persists only ciphertext, returns only status to settings, and removes the key', async () => {
  directory = await mkdtemp(join(tmpdir(), 'groq-key-'))
  const path = join(directory, 'key.enc'); const store = new GroqKeyStore(path)
  await store.set('private-key')
  expect((await readFile(path)).toString()).not.toContain('private-key')
  expect(await store.status()).toEqual({ configured: true, encryptionAvailable: true })
  expect(await store.read()).toBe('private-key')
  await store.set(null); expect(await store.read()).toBeNull()
})
it('refuses storage when Electron cannot encrypt', async () => {
  directory = await mkdtemp(join(tmpdir(), 'groq-key-'))
  secure.available = false
  const store = new GroqKeyStore(join(directory, 'key.enc'))
  await expect(store.set('private-key')).rejects.toThrow('Secure key storage is unavailable')
  expect(await store.read()).toBeNull()
})
