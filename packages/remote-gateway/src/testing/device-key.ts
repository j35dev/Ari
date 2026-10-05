import { generateKeyPairSync, sign } from 'node:crypto'

/**
 * A device keypair shaped like the one the mobile client generates in Web
 * Crypto: ECDSA P-256, exported as a JWK, signing with a DER-encoded
 * signature. Using the real primitive rather than a stub is the point — the
 * gateway verifies signatures with `node:crypto`, and a stub would agree with
 * a bug in either end.
 */
export function deviceKey(): {
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  sign: (nonce: string) => string
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  return {
    jwk,
    sign: (nonce) =>
      sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  }
}
