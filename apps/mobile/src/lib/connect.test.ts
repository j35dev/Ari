import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceKeyring, MemoryDeviceStore } from './device-key'
import { connectRequest, ManagedLeaseClient } from './connect'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('managed membership leases', () => {
  it('signs a fresh computer/device-bound proof and coalesces concurrent renewal', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({
      deviceId: 'device_1',
      displayName: 'Phone',
      projectIds: ['project_1'],
    })
    const calls: { path: string; options: unknown }[] = []
    const request: typeof connectRequest = async <T>(
      path: string,
      options?: unknown,
    ): Promise<T> => {
      calls.push({ path, options })
      return (
        path === '/me'
          ? { csrfToken: 'csrf-token' }
          : {
              lease: {
                token: 'signed.lease.token',
                expiresAt: new Date(Date.now() + 120000).toISOString(),
              },
            }
      ) as T
    }
    const leases = new ManagedLeaseClient('computer_1', keyring, request)
    expect(await Promise.all([leases.token(), leases.token()])).toEqual([
      'signed.lease.token',
      'signed.lease.token',
    ])
    expect(calls.map((call) => call.path)).toEqual(['/me', '/leases/renew'])
    const options = calls[1]?.options as {
      csrfToken: string
      body: {
        computerId: string
        deviceId: string
        timestamp: number
        nonce: string
        signature: string
      }
    }
    expect(options.csrfToken).toBe('csrf-token')
    expect(options.body).toMatchObject({ computerId: 'computer_1', deviceId: 'device_1' })
    const proof = options.body
    const key = await keyring.key()
    const signature = Uint8Array.from(Buffer.from(proof.signature, 'base64url'))
    expect(signature).toHaveLength(64)
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key.publicKey,
        signature,
        new TextEncoder().encode(
          `ari-connect/lease/v1\ncomputer_1\ndevice_1\n${proof.timestamp}\n${proof.nonce}`,
        ),
      ),
    ).toBe(true)
    expect(await leases.token()).toBe('signed.lease.token')
    expect(calls).toHaveLength(2)
    await leases.token(true)
    const next = (calls[3]?.options as typeof options).body
    expect(next.nonce).not.toBe(proof.nonce)
  })
  it('rejects expired or overlong leases and does not cache a failed renewal', async () => {
    const keyring = new DeviceKeyring(new MemoryDeviceStore())
    await keyring.remember({ deviceId: 'device_1', displayName: 'Phone', projectIds: [] })
    let duration = -1000
    const request: typeof connectRequest = async <T>(path: string): Promise<T> =>
      (path === '/me'
        ? { csrfToken: 'csrf' }
        : {
            lease: { token: 'token', expiresAt: new Date(Date.now() + duration).toISOString() },
          }) as T
    const leases = new ManagedLeaseClient('computer_1', keyring, request)
    await expect(leases.token()).rejects.toThrow('invalid membership lease')
    duration = 300000
    await expect(leases.token()).rejects.toThrow('invalid membership lease')
    duration = 120000
    await expect(leases.token()).resolves.toBe('token')
  })
  it('requires desktop pairing before sending any membership request', async () => {
    const request = vi.fn()
    const leases = new ManagedLeaseClient(
      'computer_1',
      new DeviceKeyring(new MemoryDeviceStore()),
      request,
    )
    await expect(leases.token()).rejects.toThrow('Pair this phone')
    expect(request).not.toHaveBeenCalled()
  })
  it('uses same-origin no-store account requests and never accepts an external account path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    await connectRequest('/auth/logout', { body: {}, csrfToken: 'csrf' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ari-csrf': 'csrf' },
      }),
    )
    await expect(connectRequest('//attacker.example/me')).rejects.toThrow('Invalid account route')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
