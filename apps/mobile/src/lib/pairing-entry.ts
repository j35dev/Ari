import { normalizePairingCode } from '@ari/contracts/remote'

export type PairingEntry =
  | { kind: 'code'; code: string }
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'error'; message: string }

const CODE_HINT = 'Enter the 8-character code shown under the QR in desktop Mobile access settings.'

/** A typed short code, a pasted pairing link for this computer, or a bare invitation id. */
export function readPairingEntry(input: string, origin: string): PairingEntry {
  const entry = input.trim()
  const code = normalizePairingCode(entry)
  if (code !== null) return { kind: 'code', code }
  if (/^inv_[\w-]+$/.test(entry)) return { kind: 'invitation', invitationId: entry }
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return { kind: 'error', message: CODE_HINT }
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    return { kind: 'error', message: 'Use the code, or the full HTTPS pairing link.' }
  if (url.origin !== origin)
    return {
      kind: 'error',
      message: 'This link belongs to another address. Use the code shown on this app’s computer.',
    }
  const invitationId = new URLSearchParams(url.hash.slice(1)).get('pair')?.trim()
  // Safari removes the invitation from its address bar once it has read it.
  if (!invitationId)
    return { kind: 'error', message: `That address has no code in it. ${CODE_HINT}` }
  return { kind: 'invitation', invitationId }
}
