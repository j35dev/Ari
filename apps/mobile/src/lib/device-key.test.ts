import { verify, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DeviceKeyring,
  IndexedDbDeviceStore,
  MemoryDeviceStore,
  defaultDeviceStore,
  rawSignatureToDer,
} from './device-key'

/**
 * The one piece of this client that a mistake would hide until a user is
 * staring at "pairing failed": Web Crypto signs ECDSA as a raw `r || s` pair,
 * and the gateway verifies with Node's DER decoder. If the conversion is
 * wrong, everything else still looks fine — the signature is the right
 * length, the request is well-formed, and only the far end says no.
 *
 * So this checks the encoding against the same `node:crypto` call the gateway
 * makes, rather than against the client's own idea of what it produced.
 */

describe('device key', () => {
  it('signs a nonce the gateway can verify', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    const publicKey = await keyring.publicKey()
    const nonce = 'a-nonce-the-server-issued'
    const signature = await keyring.sign(nonce)

    const verified = verify(
      'sha256',
      Buffer.from(nonce),
      { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'der' },
      Buffer.from(signature, 'base64'),
    )
    expect(verified).toBe(true)
  })

  it('keeps the key across a store round trip, as a restart would', async () => {
    const store = new MemoryDeviceStore()
    const first = new DeviceKeyring(store)
    const publicKey = await first.publicKey()
    await first.sign('warm the key up')

    const second = new DeviceKeyring(store)
    await second.load()
    expect(await second.publicKey()).toEqual(publicKey)
  })

  it('signs a different value every time, over different nonces', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    const one = await keyring.sign('nonce-one')
    const two = await keyring.sign('nonce-two')
    expect(one).not.toBe(two)
  })

  it('rejects a signature that is not a P-256 pair of integers', () => {
    // A silently mis-sized buffer is a signature that never verifies, and the
    // failure would surface as "pairing refused" with nothing to go on.
    expect(() => rawSignatureToDer(new Uint8Array(63))).toThrow()
  })

  it('encodes the halves the way DER requires', () => {
    // r and s with their high bits set: a DER INTEGER is signed, so each needs
    // a leading zero byte — the bug that produces a valid-looking signature
    // that Node rejects for about half of all nonces.
    const raw = new Uint8Array(64)
    raw[0] = 0x80
    raw[32] = 0x01
    const der = rawSignatureToDer(raw)
    expect(der[0]).toBe(0x30)
    expect(Array.from(der.subarray(2, 5))).toEqual([0x02, 0x21, 0x00])

    const plain = new Uint8Array(64)
    plain[0] = 0x7f
    plain[32] = 0x00
    const compact = rawSignatureToDer(plain)
    // Leading zeros are dropped, so s is a single byte here.
    expect(compact.length).toBeLessThan(der.length)
  })

  it('chooses durable storage when the probe passes, memory when it fails', async () => {
    expect(await defaultDeviceStore(async () => true)).toBeInstanceOf(IndexedDbDeviceStore)
    expect(await defaultDeviceStore(async () => false)).toBeInstanceOf(MemoryDeviceStore)
    expect(await defaultDeviceStore(async () => Promise.reject(new Error('nope')))).toBeInstanceOf(
      MemoryDeviceStore,
    )
  })

  it('forgets only when told to', async () => {
    const store = new MemoryDeviceStore()
    const keyring = new DeviceKeyring(store)
    await keyring.remember({ deviceId: 'dev_1', displayName: 'Pixel', projectIds: ['p1'] })
    expect(keyring.deviceId).toBe('dev_1')

    await keyring.forget()
    expect(keyring.deviceId).toBeNull()
    expect(await store.loadKey()).toBeNull()
  })
})
