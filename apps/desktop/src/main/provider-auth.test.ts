import { describe, expect, it, vi } from 'vitest'
import { AUTH_REQUIRED_ERROR } from '@ari/providers/acp/protocol'
import type { AcpTerminalLogin } from '@ari/providers/acp/protocol'
import type { RpcResults } from '@ari/contracts/rpc'
import {
  AUTH_PROBE_TTL_MS,
  ProviderAuthState,
  probeProviderAuth,
  resolveProviderLogins,
} from './provider-auth'
import type { AuthProbeConnection, AuthProbeDeps } from './provider-auth'

const CLAUDE_LOGIN: AcpTerminalLogin = {
  methodId: 'claude-ai-login',
  name: 'Claude Subscription',
  description: 'Use Claude subscription',
  command: 'node',
  args: ['acp.js', '--cli', 'auth', 'login', '--claudeai'],
}

function authWall(logins: AcpTerminalLogin[]): Error {
  const error = new Error('needs you to sign in again')
  Object.assign(error, { code: AUTH_REQUIRED_ERROR, logins })
  return error
}

function detection(over: Partial<RpcResults['providers.detect'][number]> = {}): RpcResults['providers.detect'] {
  return [
    {
      kind: 'claude',
      installed: true,
      binaryPath: '/usr/local/bin/claude',
      version: '2.1.0',
      authStatus: 'authenticated',
      ...over,
    },
  ]
}

function connectionThat(
  newSession: () => Promise<unknown>,
  logins: AcpTerminalLogin[] = [],
): AuthProbeConnection & { killed: boolean } {
  const connection = {
    terminalLogins: logins,
    newSession,
    killed: false,
    shutdown: async () => {
      connection.killed = true
    },
  }
  return connection
}

function deps(over: Partial<AuthProbeDeps> = {}): AuthProbeDeps {
  return {
    detections: async () => detection(),
    connect: async () => connectionThat(async () => ({ sessionId: 'probe_1' })),
    cwd: () => '/home/u',
    ...over,
  }
}

describe('probeProviderAuth', () => {
  it('reports ready when the existing harness already opens a session', async () => {
    const probe = await probeProviderAuth('claude', deps(), new ProviderAuthState())
    expect(probe).toEqual({ status: 'ready', label: 'claude', version: '2.1.0' })
  })

  it('never offers a login for a provider that is not installed', async () => {
    const probe = await probeProviderAuth(
      'claude',
      deps({
        detections: async () =>
          detection({
            installed: false,
            binaryPath: null,
            authStatus: 'unknown',
            authReason: 'Not installed - Ari cannot check credentials until the CLI is present.',
          }),
      }),
      new ProviderAuthState(),
    )
    expect(probe.status).toBe('unknown')
    expect(probe).toMatchObject({ reason: /Not installed/ })
  })

  it('offers the agent-advertised logins when the session is genuinely refused', async () => {
    const probe = await probeProviderAuth(
      'claude',
      deps({
        connect: async () =>
          connectionThat(async () => {
            throw authWall([CLAUDE_LOGIN])
          }, [CLAUDE_LOGIN]),
      }),
      new ProviderAuthState(),
    )
    expect(probe).toEqual({
      status: 'auth-required',
      label: 'claude',
      logins: [CLAUDE_LOGIN],
    })
  })

  it('treats an unreachable agent as unknown, not as a logged-out user', async () => {
    const probe = await probeProviderAuth(
      'claude',
      deps({
        connect: async () => {
          throw new Error('npx failed before the agent started')
        },
      }),
      new ProviderAuthState(),
    )
    expect(probe.status).toBe('unknown')
  })

  it('answers unknown for a kind with no ACP transport instead of guessing', async () => {
    const probe = await probeProviderAuth(
      'claude',
      deps({ connect: async () => null }),
      new ProviderAuthState(),
    )
    expect(probe).toMatchObject({ status: 'unknown', reason: /no ACP transport/ })
  })

  it('always kills the throwaway probe connection', async () => {
    const connection = connectionThat(async () => ({ sessionId: 'probe_1' }))
    await probeProviderAuth('claude', deps({ connect: async () => connection }), new ProviderAuthState())
    expect(connection.killed).toBe(true)
  })

  it('trusts a live wall over a fresh probe, and never spawns an adapter to re-ask', async () => {
    const connect = vi.fn()
    const state = new ProviderAuthState()
    state.recordWall('claude', 'claude (ACP adapter)', [CLAUDE_LOGIN])

    const probe = await probeProviderAuth('claude', deps({ connect }), state)
    expect(probe).toEqual({
      status: 'auth-required',
      label: 'claude (ACP adapter)',
      logins: [CLAUDE_LOGIN],
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('caches a verdict, and a live wall invalidates a stale ready', async () => {
    const connect = vi.fn(async () => connectionThat(async () => ({ sessionId: 'probe_1' })))
    const state = new ProviderAuthState()

    await probeProviderAuth('claude', deps({ connect }), state)
    await probeProviderAuth('claude', deps({ connect }), state)
    expect(connect).toHaveBeenCalledTimes(1)

    state.recordWall('claude', 'claude', [CLAUDE_LOGIN])
    const after = await probeProviderAuth('claude', deps({ connect }), state)
    expect(after.status).toBe('auth-required')
  })

  it('re-probes once the cached verdict ages out', async () => {
    let now = 1_000
    const connect = vi.fn(async () => connectionThat(async () => ({ sessionId: 'probe_1' })))
    const state = new ProviderAuthState(() => now)

    await probeProviderAuth('claude', deps({ connect }), state)
    now += AUTH_PROBE_TTL_MS + 1
    await probeProviderAuth('claude', deps({ connect }), state)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('re-tests for real after a login attempt clears the wall', async () => {
    const state = new ProviderAuthState()
    state.recordWall('claude', 'claude', [CLAUDE_LOGIN])
    state.clear('claude')

    const probe = await probeProviderAuth('claude', deps(), state)
    expect(probe.status).toBe('ready')
  })
})

describe('resolveProviderLogins', () => {
  it('hands back the logins from the live wall', async () => {
    const state = new ProviderAuthState()
    state.recordWall('claude', 'claude (ACP adapter)', [CLAUDE_LOGIN])
    expect(await resolveProviderLogins('claude', deps(), state)).toEqual({
      label: 'claude (ACP adapter)',
      logins: [CLAUDE_LOGIN],
    })
  })

  it('falls back to the preflight when no wall has been seen', async () => {
    const resolved = await resolveProviderLogins(
      'claude',
      deps({
        connect: async () =>
          connectionThat(async () => {
            throw authWall([CLAUDE_LOGIN])
          }, [CLAUDE_LOGIN]),
      }),
      new ProviderAuthState(),
    )
    expect(resolved.logins).toEqual([CLAUDE_LOGIN])
  })

  it('answers an empty list for a working provider so no dead button renders', async () => {
    expect(await resolveProviderLogins('claude', deps(), new ProviderAuthState())).toEqual({
      label: 'claude',
      logins: [],
    })
  })
})
