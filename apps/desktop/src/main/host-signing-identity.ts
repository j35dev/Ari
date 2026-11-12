import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SecretBox } from '@ari/ari-core/endpoints'
import { createHostRouteSigner, type HostRouteSigner } from '@ari/remote-gateway/route-auth'

const stored = z.object({ version: z.literal(1), hostId: z.string().min(1).max(200), cipher: z.string().min(1).max(16384) }).strict()
const plain = z.object({ hostId: z.string(), privateKeyPem: z.string().min(1).max(8192) }).strict()
/** No reset, recovery-by-regeneration or plaintext fallback for an existing signing identity. */
export function loadHostSigningIdentity(dir: string, hostId: string, secretBox: () => SecretBox | null): HostRouteSigner {
  const box = secretBox()
  if (box === null) throw new Error('Secure host signing storage is unavailable.')
  const path = join(dir, 'host-signing.json')
  let raw: string
  try {
    if (statSync(path).size > 32768) throw new Error('Host signing identity is too large.')
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const cipher = box.encrypt(JSON.stringify({ hostId, privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString() }))
    raw = JSON.stringify(stored.parse({ version: 1, hostId, cipher }))
    mkdirSync(dir, { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  }
  const record = stored.parse(JSON.parse(raw))
  if (record.hostId !== hostId) throw new Error('Host signing identity belongs to another host.')
  const decrypted = box.decrypt(record.cipher)
  if (decrypted === null) throw new Error('Host signing identity cannot be unlocked.')
  const key = plain.parse(JSON.parse(decrypted))
  if (key.hostId !== hostId) throw new Error('Sealed host signing identity mismatch.')
  return createHostRouteSigner(hostId, createPrivateKey(key.privateKeyPem))
}
