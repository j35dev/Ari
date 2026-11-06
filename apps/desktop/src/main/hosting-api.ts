import type { SourceControlConnect, SourceControlRepository } from '@ari/contracts/rpc'
import { runHostCommand, type HostCommand } from './change-requests'
import type { SourceControlConnections } from './source-control-connections'

export class HostingError extends Error {
  constructor(
    readonly code: 'unauthenticated' | 'rate-limited' | 'failed' | 'unsupported' | 'unavailable',
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** Provider API origins are derived locally, never from a server-supplied link. */
export function apiBase(host: Pick<SourceControlRepository, 'provider' | 'instance'>): string {
  const base = host.instance.replace(/\/$/, '')
  switch (host.provider) {
    case 'github':
      return base === 'https://github.com'
        ? 'https://api.github.com'
        : new URL(base).hostname.endsWith('.ghe.com')
          ? `https://api.${new URL(base).hostname}`
          : `${base}/api/v3`
    case 'gitlab':
      return `${base}/api/v4`
    case 'forgejo':
      return `${base}/api/v1`
    case 'bitbucket':
      return base === 'https://bitbucket.org'
        ? 'https://api.bitbucket.org/2.0'
        : `${base}/rest/api/1.0`
    case 'azure-devops':
      return base
    case 'gitcafe':
      return `${base}/api`
    default:
      throw new HostingError(
        'unsupported',
        'Configure this hosting instance in Source control settings.',
      )
  }
}

export class HostingApi {
  constructor(
    readonly connections: SourceControlConnections,
    readonly run: HostCommand = runHostCommand,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(
    host: Pick<SourceControlRepository, 'provider' | 'instance'>,
    path: string,
    options: {
      method?: string
      body?: unknown
      signal?: AbortSignal
      raw?: boolean
      credential?: Pick<SourceControlConnect, 'token' | 'username'>
    } = {},
  ): Promise<unknown> {
    const method = options.method ?? 'GET'
    const credential = options.credential ?? this.connections.credential(host.instance)
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000)
    if (signal.aborted) throw new HostingError('unavailable', 'Request cancelled.')
    if (!credential?.token && (host.provider === 'github' || host.provider === 'gitlab')) {
      const command = host.provider === 'github' ? 'gh' : 'glab'
      const instance = new URL(host.instance)
      const endpoint =
        host.provider === 'github'
          ? path.replace(/^\//, '')
          : `${instance.pathname.replace(/\/$/, '')}${path}`.replace(/^\//, '')
      try {
        const { stdout } = await this.run(
          command,
          [
            'api',
            '--hostname',
            instance.host,
            endpoint,
            '--method',
            method,
            ...(options.raw && command === 'gh'
              ? ['--header', 'Accept: application/vnd.github.diff']
              : []),
            ...(options.body !== undefined ? ['--input', '-'] : []),
          ],
          process.cwd(),
          signal,
          options.body !== undefined ? { input: JSON.stringify(options.body) } : undefined,
        )
        return options.raw ? stdout : JSON.parse(stdout)
      } catch {
        throw new HostingError(
          signal.aborted ? 'unavailable' : 'unauthenticated',
          signal.aborted
            ? 'Request cancelled or timed out.'
            : `Sign in with ${command} auth login, or connect an access token in Source control settings.`,
        )
      }
    }
    if (!credential?.token)
      throw new HostingError(
        'unauthenticated',
        'Connect an access token for this instance in Source control settings.',
      )
    const headers: Record<string, string> = {
      Accept: options.raw
        ? host.provider === 'github'
          ? 'application/vnd.github.diff'
          : 'text/plain'
        : 'application/json',
      'Content-Type': 'application/json',
    }
    if (host.provider === 'gitlab') headers['PRIVATE-TOKEN'] = credential.token
    else if (host.provider === 'azure-devops')
      headers.Authorization = `Basic ${Buffer.from(`:${credential.token}`).toString('base64')}`
    else if (host.provider === 'bitbucket' && credential.username)
      headers.Authorization = `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString('base64')}`
    else headers.Authorization = `Bearer ${credential.token}`
    const base =
      host.provider === 'github' &&
      path === '/graphql' &&
      host.instance !== 'https://github.com' &&
      !new URL(host.instance).hostname.endsWith('.ghe.com')
        ? `${host.instance}/api`
        : apiBase(host)
    // Do not accept absolute URLs or traversal from an adapter, and never forward credentials on redirects.
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.split('?')[0]!.split('/').includes('..')
    )
      throw new HostingError('failed', 'Invalid hosting API path.')
    try {
      const followsDiff = host.provider === 'bitbucket' && options.raw && method === 'GET'
      let target = `${base}${path}`
      let response: Response
      for (let redirects = 0; ; redirects++) {
        response = await this.fetcher(target, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
          redirect: followsDiff ? 'manual' : 'error',
        })
        if (!followsDiff || ![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        const next = location ? new URL(location, target) : null
        const origin = new URL(base)
        if (
          redirects >= 3 ||
          !next ||
          next.origin !== origin.origin ||
          next.username ||
          next.password ||
          next.hash ||
          !next.pathname.startsWith(`${origin.pathname.replace(/\/$/, '')}/`)
        )
          throw new HostingError('failed', 'The host returned an untrusted diff redirect.')
        await response.body?.cancel()
        target = next.href
      }
      if (!response.ok) {
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after')))
        const code =
          response.status === 401 ? 'unauthenticated' : limited ? 'rate-limited' : 'failed'
        throw new HostingError(
          code,
          limited
            ? 'The host rate limit was reached. Retry shortly.'
            : response.status === 401
              ? 'The hosting token expired or is invalid. Reconnect in Source control settings.'
              : response.status === 403
                ? 'This token does not have permission for this action.'
                : response.status === 404
                  ? 'The repository or request was not found. Check the remote and token access.'
                  : `The hosting service returned HTTP ${response.status}.`,
          response.status,
        )
      }
      if (response.status === 204) return null
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > 8 * 1024 * 1024)
            throw new HostingError('failed', 'The hosting response is too large to display.')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return options.raw ? text : text ? JSON.parse(text) : null
    } catch (error) {
      if (error instanceof HostingError) throw error
      throw new HostingError(
        signal.aborted ? 'unavailable' : 'failed',
        signal.aborted
          ? 'Request cancelled or timed out.'
          : 'Could not reach or read the hosting service. Check the instance URL and retry.',
      )
    }
  }
}
