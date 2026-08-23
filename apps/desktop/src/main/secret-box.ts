import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SecretBox } from '@ari/ari-core/endpoints'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:secret-box')

/** Redaction marker used by EndpointStore.list() — never a real cipher. */
const REDACTED = '••••'

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Fallback key file name under the secrets dir. */
export const SECRET_KEY_FILE = 'endpoints.key'

/**
 * Structural subset of Electron's `safeStorage` the adapter relies on;
 * declared locally so this module stays unit-testable without Electron.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(cipher: Buffer): string
}

/**
 * OS-keyring box (DPAPI/Keychain/libsecret via Electron safeStorage).
 * Ciphertext is base64 of the platform blob; any undecryptable input maps
 * to null so callers can detect legacy plaintext or corruption.
 */
export function safeStorageBox(storage: SafeStorageLike): SecretBox {
  return {
    encrypt(plaintext) {
      return storage.encryptString(plaintext).toString('base64')
    },
    decrypt(cipher) {
      try {
        return storage.decryptString(Buffer.from(cipher, 'base64'))
      } catch {
        return null
      }
    },
  }
}

/**
 * AES-256-GCM box over a raw key; ciphertext format is base64(iv ‖ tag ‖
 * data). Tampered or malformed input decrypts to null instead of throwing.
 */
export function aesGcmSecretBox(key: Buffer): SecretBox {
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const aead = createCipheriv('aes-256-gcm', key, iv)
      const sealed = Buffer.concat([aead.update(plaintext, 'utf8'), aead.final()])
      return Buffer.concat([iv, aead.getAuthTag(), sealed]).toString('base64')
    },
    decrypt(cipher) {
      let raw: Buffer
      try {
        raw = Buffer.from(cipher, 'base64')
      } catch {
        return null
      }
      if (raw.length <= IV_BYTES + TAG_BYTES) return null
      try {
        const aead = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
        aead.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
        const plain = Buffer.concat([
          aead.update(raw.subarray(IV_BYTES + TAG_BYTES)),
          aead.final(),
        ])
        return plain.toString('utf8')
      } catch {
        return null
      }
    },
  }
}

/**
 * Loads the 32-byte fallback key from `keyPath`, creating it (mode 0600 where
 * the platform honors it) on first use. A wrong-sized file is replaced rather
 * than poisoning every future decrypt.
 */
export function loadOrCreateKeyFile(keyPath: string): Buffer {
  mkdirSync(dirname(keyPath), { recursive: true })
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath)
    if (existing.length === KEY_BYTES) return existing
    log.warn('secret key file has wrong size; regenerating', { keyPath })
    rmSync(keyPath, { force: true })
  }
  const key = randomBytes(KEY_BYTES)
  let fd: number
  try {
    fd = openSync(keyPath, 'wx')
  } catch {
    // Lost a creation race (or the file reappeared): use the winner's key.
    return readFileSync(keyPath)
  }
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, key)
  } finally {
    closeSync(fd)
  }
  return key
}

export interface ResolveSecretBoxOptions {
  /** Electron safeStorage; omit in tests. Null forces the fallback box. */
  storage?: SafeStorageLike | null
  /** Directory hosting the fallback key file (typically <userData>/secrets). */
  keyDir: string
}

/**
 * Picks the endpoint-key SecretBox for this machine: the OS keyring when
 * safeStorage reports encryption available (headless Linux often does not),
 * otherwise an AES-256-GCM file-backed box per arch-11.
 */
export function resolveSecretBox(options: ResolveSecretBoxOptions): SecretBox {
  let available = false
  if (options.storage) {
    try {
      available = options.storage.isEncryptionAvailable()
    } catch (error) {
      log.warn('safeStorage availability probe failed', { error: String(error) })
    }
  }
  if (available && options.storage) return safeStorageBox(options.storage)
  log.info('safeStorage unavailable; endpoint keys use encrypted-file fallback')
  return aesGcmSecretBox(loadOrCreateKeyFile(join(options.keyDir, SECRET_KEY_FILE)))
}

/**
 * One-time migration for endpoints.json written by pre-encryption builds:
 * every apiKeyCipher that fails to decrypt is treated as legacy plaintext,
 * re-encrypted in place, and the file rewritten atomically. Idempotent —
 * already-encrypted files are left untouched. Returns true when rewritten.
 *
 * Note: ciphers that fail to decrypt for non-legacy reasons (box switched,
 * key lost) are indistinguishable from plaintext and get re-encrypted as
 * opaque strings; those keys were unrecoverable either way.
 */
export function migrateLegacyPlaintextKeys(endpointsPath: string, box: SecretBox): boolean {
  let entries: unknown
  try {
    entries = JSON.parse(readFileSync(endpointsPath, 'utf8'))
  } catch {
    return false
  }
  if (!Array.isArray(entries)) return false
  const list: unknown[] = entries
  let changed = false
  const migrated = list.map((entry): unknown => {
    if (typeof entry !== 'object' || entry === null) return entry
    const record = entry as Record<string, unknown>
    const cipher = record['apiKeyCipher']
    if (typeof cipher !== 'string' || cipher.length === 0 || cipher === REDACTED) return entry
    if (box.decrypt(cipher) !== null) return entry
    changed = true
    return { ...record, apiKeyCipher: box.encrypt(cipher) }
  })
  if (!changed) return false
  const tmpPath = `${endpointsPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(migrated, null, 2), 'utf8')
  renameSync(tmpPath, endpointsPath)
  return true
}
