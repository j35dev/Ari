import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EndpointStore } from '@ari/ari-core/endpoints'
import {
  SECRET_KEY_FILE,
  aesGcmSecretBox,
  loadOrCreateKeyFile,
  migrateLegacyPlaintextKeys,
  resolveSecretBox,
  safeStorageBox,
  type SafeStorageLike,
} from './secret-box'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-secret-box-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Deterministic fake of Electron safeStorage: `1,2,3` blob prefix + payload. */
function fakeStorage(available: boolean): SafeStorageLike {
  const prefix = Buffer.from([1, 2, 3])
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => Buffer.concat([prefix, Buffer.from(plaintext, 'utf8')]),
    decryptString: (cipher) => {
      if (!cipher.subarray(0, 3).equals(prefix)) throw new Error('not an encrypted blob')
      return cipher.subarray(3).toString('utf8')
    },
  }
}

describe('safeStorageBox', () => {
  it('round-trips keys through the platform adapter as base64', () => {
    const box = safeStorageBox(fakeStorage(true))
    const cipher = box.encrypt('sk-live-123')
    expect(cipher).not.toContain('sk-live-123')
    expect(box.decrypt(cipher)).toBe('sk-live-123')
  })

  it('maps undecryptable input to null instead of throwing', () => {
    const box = safeStorageBox(fakeStorage(true))
    expect(box.decrypt('plainly-a-key')).toBeNull()
  })
})

describe('aesGcmSecretBox', () => {
  it('round-trips keys and never emits plaintext or repeated ciphertext', () => {
    const box = aesGcmSecretBox(loadOrCreateKeyFile(join(dir, SECRET_KEY_FILE)))
    const first = box.encrypt('sk-live-123')
    const second = box.encrypt('sk-live-123')
    expect(first).not.toContain('sk-live-123')
    expect(first).not.toBe(second)
    expect(box.decrypt(first)).toBe('sk-live-123')
    expect(box.decrypt(second)).toBe('sk-live-123')
  })

  it('returns null for plaintext, truncated, or tampered ciphers', () => {
    const box = aesGcmSecretBox(loadOrCreateKeyFile(join(dir, SECRET_KEY_FILE)))
    expect(box.decrypt('sk-legacy-plaintext')).toBeNull()
    expect(box.decrypt('aGVsbG8=')).toBeNull()
    const cipher = box.encrypt('sk-live-123')
    const raw = Buffer.from(cipher, 'base64')
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff
    expect(box.decrypt(raw.toString('base64'))).toBeNull()
  })
})

describe('loadOrCreateKeyFile', () => {
  it('creates a 32-byte key once and reuses it', async () => {
    const keyPath = join(dir, 'secrets', SECRET_KEY_FILE)
    const first = loadOrCreateKeyFile(keyPath)
    const second = loadOrCreateKeyFile(keyPath)
    expect(first).toEqual(second)
    expect(first.length).toBe(32)
    const info = await stat(keyPath)
    // Windows maps the write bit onto read-only; assert the low bits where honored.
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600)
    }
  })

  it('regenerates wrong-sized key files instead of failing forever', async () => {
    const keyPath = join(dir, SECRET_KEY_FILE)
    await writeFile(keyPath, 'too small', 'utf8')
    const key = loadOrCreateKeyFile(keyPath)
    expect(key.length).toBe(32)
    expect(loadOrCreateKeyFile(keyPath)).toEqual(key)
  })
})

describe('resolveSecretBox', () => {
  it('prefers the safeStorage adapter when encryption is available', () => {
    const box = resolveSecretBox({ storage: fakeStorage(true), keyDir: dir })
    const cipher = box.encrypt('sk-live-123')
    expect(safeStorageBox(fakeStorage(true)).decrypt(cipher)).toBe('sk-live-123')
  })

  it('falls back to the file-key AES box when safeStorage is missing', async () => {
    const box = resolveSecretBox({ storage: fakeStorage(false), keyDir: dir })
    expect(box.encrypt('sk-live-123')).not.toContain('sk-live-123')
    expect(box.decrypt(box.encrypt('sk-live-123'))).toBe('sk-live-123')
    await expect(stat(join(dir, SECRET_KEY_FILE))).resolves.toBeTruthy()
  })

  it('reuses one fallback key across resolutions', () => {
    const first = resolveSecretBox({ keyDir: dir })
    const second = resolveSecretBox({ keyDir: dir })
    expect(second.decrypt(first.encrypt('sk-live-123'))).toBe('sk-live-123')
  })
})

describe('endpoint store call site', () => {
  const legacyEndpoint = {
    id: 'ep_1',
    name: 'Local',
    baseUrl: 'https://api.example.com',
    flavor: 'openai-chat' as const,
    model: 'gpt-test',
    apiKeyCipher: 'sk-legacy-plaintext',
  }

  function endpointsPath(): string {
    return join(dir, 'endpoints.json')
  }

  it('keeps keys readable through the boxed store after migration', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(endpointsPath(), JSON.stringify([legacyEndpoint], null, 2), 'utf8')

    const box = resolveSecretBox({ storage: fakeStorage(false), keyDir: dir })
    expect(migrateLegacyPlaintextKeys(endpointsPath(), box)).toBe(true)

    const stored = await readFile(endpointsPath(), 'utf8')
    expect(stored).not.toContain('sk-legacy-plaintext')

    const store = new EndpointStore({ dir, secretBox: box })
    await store.load()
    expect(store.list()[0]?.apiKeyCipher).toBe('••••')
    expect(store.apiKeyFor('ep_1')).toBe('sk-legacy-plaintext')

    expect(migrateLegacyPlaintextKeys(endpointsPath(), box)).toBe(false)
  })

  it('leaves encrypted files untouched by migration', async () => {
    const box = resolveSecretBox({ storage: fakeStorage(true), keyDir: dir })
    const encrypted = { ...legacyEndpoint, apiKeyCipher: box.encrypt('sk-kept') }
    await writeFile(endpointsPath(), JSON.stringify([encrypted], null, 2), 'utf8')

    expect(migrateLegacyPlaintextKeys(endpointsPath(), box)).toBe(false)

    const store = new EndpointStore({ dir, secretBox: box })
    await store.load()
    expect(store.apiKeyFor('ep_1')).toBe('sk-kept')
  })

  it('is a no-op when no endpoints file exists yet', async () => {
    const box = resolveSecretBox({ keyDir: dir })
    expect(migrateLegacyPlaintextKeys(endpointsPath(), box)).toBe(false)
  })

  it('stores new keys encrypted while the passthrough store leaks them to disk', async () => {
    const boxedDir = join(dir, 'boxed')
    const plainDir = join(dir, 'passthrough')
    await mkdir(boxedDir, { recursive: true })
    await mkdir(plainDir, { recursive: true })

    const boxed = new EndpointStore({
      dir: boxedDir,
      secretBox: resolveSecretBox({ storage: fakeStorage(false), keyDir: boxedDir }),
    })
    await boxed.upsert({ ...legacyEndpoint, headers: {}, apiKey: 'sk-new-key' })
    await expect(readFile(join(boxedDir, 'endpoints.json'), 'utf8')).resolves.not.toContain(
      'sk-new-key',
    )
    expect(boxed.apiKeyFor('ep_1')).toBe('sk-new-key')

    const passthrough = new EndpointStore({ dir: plainDir })
    await passthrough.upsert({ ...legacyEndpoint, headers: {}, apiKey: 'sk-new-key' })
    await expect(readFile(join(plainDir, 'endpoints.json'), 'utf8')).resolves.toContain(
      'sk-new-key',
    )
  })
})
