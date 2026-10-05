// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ResetCreditClient } from './reset-credits'
import { createResetCreditService } from './reset-credits'

function client(overrides: Partial<ResetCreditClient> = {}): ResetCreditClient {
  return {
    now: () => Date.parse('2026-09-01T00:00:00Z'),
    platform: 'win32',
    configDir: () => 'C:\\claude',
    accountPath: () => 'C:\\home\\.claude.json',
    cliVersion: async () => '2.1.289',
    readText: vi.fn(async (path: string) => {
      if (path.endsWith('.credentials.json')) {
        return JSON.stringify({ claudeAiOauth: { accessToken: 'token' } })
      }
      if (path.endsWith('.claude.json')) {
        return JSON.stringify({ oauthAccount: { organizationUuid: 'org_1' } })
      }
      return null
    }),
    fetchJson: vi.fn(async () => ({ status: 200, json: {} })),
    codexRequest: vi.fn(async () => ({ outcome: 'reset' })),
    newKey: () => 'key-1',
    ...overrides,
  }
}

describe('reset credits', () => {
  it('retries a timed-out Codex redemption with the same idempotency key', async () => {
    const keys: string[] = []
    let attempt = 0
    const service = createResetCreditService(
      client({
        newKey: () => `key-${keys.length + 1}`,
        codexRequest: vi.fn(async (_binary, _method, params) => {
          attempt += 1
          keys.push((params as { idempotencyKey: string }).idempotencyKey)
          if (attempt === 1) throw new Error('timed out')
          return { outcome: 'reset' }
        }),
      }),
    )
    await expect(service.consume({ kind: 'codex', binaryPath: 'codex' })).rejects.toThrow(
      'Codex could not use the reset.',
    )
    await expect(service.consume({ kind: 'codex', binaryPath: 'codex' })).resolves.toBe('reset')
    expect(keys).toEqual(['key-1', 'key-1'])
  })

  it('shares one in-flight Codex redemption', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = createResetCreditService(
      client({
        codexRequest: vi.fn(async () => {
          calls += 1
          await gate
          return { outcome: 'nothingToReset' }
        }),
      }),
    )
    const first = service.consume({ kind: 'codex', binaryPath: 'codex' })
    const second = service.consume({ kind: 'codex', binaryPath: 'codex' })
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      'nothingToReset',
      'nothingToReset',
    ])
    expect(calls).toBe(1)
  })

  it('claims the displayed Claude grant and keeps the request id when unconfirmed', async () => {
    const bodies: unknown[] = []
    const fetchJson = vi.fn(async (_url: string, init: { body?: string }) => {
      bodies.push(init.body ? JSON.parse(init.body) : null)
      return {
        status: 200,
        json: { result: bodies.length === 1 ? 'unavailable' : 'reset' },
      }
    })
    const service = createResetCreditService(
      client({
        newKey: () => 'request-1',
        fetchJson,
      }),
    )
    await expect(
      service.consume({ kind: 'claude', binaryPath: 'claude', creditId: 'grant_a' }),
    ).rejects.toThrow('could not confirm')
    await expect(
      service.consume({ kind: 'claude', binaryPath: 'claude', creditId: 'grant_b' }),
    ).resolves.toBe('reset')
    expect(bodies).toEqual([
      { program: 'cedar_ember', grant_id: 'grant_a', request_id: 'request-1' },
      { program: 'cedar_ember', grant_id: 'grant_a', request_id: 'request-1' },
    ])
  })

  it('does not bank a second key after Claude answers with a cooldown', async () => {
    const keys: string[] = []
    let n = 0
    const service = createResetCreditService(
      client({
        newKey: () => `request-${++n}`,
        fetchJson: vi.fn(async (_url: string, init: { body?: string }) => {
          const parsed: unknown = JSON.parse(init.body ?? '{}')
          const requestId =
            parsed && typeof parsed === 'object' && 'request_id' in parsed
              ? parsed.request_id
              : undefined
          keys.push(typeof requestId === 'string' ? requestId : '')
          return { status: 200, json: { result: keys.length === 1 ? 'cooldown' : 'reset' } }
        }),
      }),
    )
    await expect(
      service.consume({ kind: 'claude', binaryPath: 'claude', creditId: 'grant_a' }),
    ).rejects.toThrow('cooling down')
    await expect(
      service.consume({ kind: 'claude', binaryPath: 'claude', creditId: 'grant_a' }),
    ).resolves.toBe('reset')
    expect(keys).toEqual(['request-1', 'request-2'])
  })

  it('returns no credit for providers that do not bank resets', async () => {
    const service = createResetCreditService(client())
    await expect(service.consume({ kind: 'grok', binaryPath: 'grok' })).resolves.toBe('noCredit')
    await expect(service.consume({ kind: 'codex', binaryPath: null })).resolves.toBe('noCredit')
  })

  it('asks Anthropic as the installed Claude CLI, which is what unlocks the reset bank', async () => {
    const headers: Record<string, string>[] = []
    const service = createResetCreditService(
      client({
        now: () => Date.parse('2026-09-01T00:00:00Z'),
        cliVersion: async () => '2.1.289',
        fetchJson: vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
          headers.push(init.headers)
          return {
            status: 200,
            json: {
              cedar_ember: {
                eligible: true,
                next_grant_id: 'grant_a',
                grants: [
                  {
                    id: 'grant_a',
                    resets_left: 1,
                    usable_now: true,
                    ends_at: '2026-12-01T00:00:00Z',
                  },
                ],
              },
            },
          }
        }),
      }),
    )
    await expect(service.readClaude('claude.exe')).resolves.toMatchObject({ availableCount: 1 })
    expect(headers[0]?.['user-agent']).toBe('claude-cli/2.1.289 (external, cli)')
  })

  it('refuses Claude redemption on macOS, where the login stays in the Keychain', async () => {
    const service = createResetCreditService(client({ platform: 'darwin' }))
    await expect(service.consume({ kind: 'claude', binaryPath: 'claude' })).rejects.toThrow(
      'Keychain',
    )
    await expect(service.readClaude()).resolves.toBeNull()
  })
})
