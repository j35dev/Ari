import type { DeviceKeyring } from './device-key'

export interface ConnectAccount {
  email: string
  isOwner: boolean
  csrfToken: string
  member: { id: string; status: string }
}
export interface ConnectComputer {
  computerId: string
  name: string
  hostname: string | null
  state: string
}
export const IS_CONNECT_BUILD = import.meta.env['VITE_ARI_CONNECT'] === 'true'

/** Account calls are same-origin and keep the HttpOnly WorkOS-backed session out of script. */
export async function connectRequest<T>(
  path: string,
  options: { body?: unknown; csrfToken?: string; method?: string; signal?: AbortSignal } = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid account route.')
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.csrfToken === undefined ? {} : { 'x-ari-csrf': options.csrfToken }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const result = (await response.json()) as T & { error?: { message?: string } }
  if (!response.ok)
    throw new Error(
      result.error?.message ??
        (response.status === 401
          ? 'Sign in to Ari Connect to continue.'
          : 'Ari Connect could not complete this request.'),
    )
  return result
}

/** Keep short-lived membership leases in memory, bound to this computer and paired key. */
export class ManagedLeaseClient {
  readonly #computerId: string
  readonly #keyring: DeviceKeyring
  readonly #request: typeof connectRequest
  #current: { token: string; expiresAt: number } | null = null
  #renewing: Promise<string> | null = null
  constructor(
    computerId: string,
    keyring: DeviceKeyring,
    request: typeof connectRequest = connectRequest,
  ) {
    this.#computerId = computerId
    this.#keyring = keyring
    this.#request = request
  }
  async token(force = false): Promise<string> {
    if (!force && this.#current !== null && this.#current.expiresAt > Date.now() + 20000)
      return this.#current.token
    if (this.#renewing !== null) return this.#renewing
    this.#renewing = this.#renew()
    try {
      return await this.#renewing
    } finally {
      this.#renewing = null
    }
  }
  async #renew(): Promise<string> {
    const deviceId = this.#keyring.deviceId
    if (deviceId === null) throw new Error('Pair this phone on your computer first.')
    const account = await this.#request<ConnectAccount>('/me')
    const timestamp = Date.now()
    const nonce = crypto.randomUUID().replaceAll('-', '')
    const signature = await this.#keyring.signManagedProof(
      `ari-connect/lease/v1\n${this.#computerId}\n${deviceId}\n${timestamp}\n${nonce}`,
    )
    const result = await this.#request<{ lease: { token: string; expiresAt: string } }>(
      '/leases/renew',
      {
        csrfToken: account.csrfToken,
        body: { computerId: this.#computerId, deviceId, timestamp, nonce, signature },
      },
    )
    const expiresAt = Date.parse(result.lease?.expiresAt)
    if (
      typeof result.lease?.token !== 'string' ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 125000
    )
      throw new Error('The service returned an invalid membership lease.')
    this.#current = { token: result.lease.token, expiresAt }
    return result.lease.token
  }
}
