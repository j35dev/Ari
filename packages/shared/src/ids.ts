/**
 * Collision-resistant identifiers with a readable type prefix,
 * e.g. `sess_9f1c...`. UUIDv4 via the platform Web Crypto API.
 */
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

export const idPrefixes = {
  session: 'sess',
  turn: 'turn',
  message: 'msg',
  event: 'evt',
  project: 'proj',
  endpoint: 'endp',
  checkpoint: 'ckpt',
  command: 'cmd',
} as const

export type IdPrefix = (typeof idPrefixes)[keyof typeof idPrefixes]

export function newTypedId(prefix: IdPrefix): string {
  return newId(prefix)
}
