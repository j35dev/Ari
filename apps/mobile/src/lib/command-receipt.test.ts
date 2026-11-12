import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from './gateway-client'
import { checkCommandReceipt } from './command-receipt'
import type { MobileSession } from './session'

describe('read-only command recovery', () => {
  it('returns the authenticated host outcome for the original receipt', async () => {
    const outcome = { ok: true, result: { accepted: true } }
    const query = vi.fn().mockResolvedValue(outcome)
    expect(await checkCommandReceipt({ query } as Pick<MobileSession, 'query'>, 'original-receipt')).toEqual(outcome)
    expect(query).toHaveBeenCalledExactlyOnceWith('command.status', { idempotencyKey: 'original-receipt' })
  })

  it.each([null, {}, { ok: false, result: {} }, { ok: true }, { ok: true, result: null }, { ok: true, result: 'corrupt' }])(
    'keeps the receipt when host history is malformed: %j', async (outcome) => {
      const query = vi.fn().mockResolvedValue(outcome)
      await expect(checkCommandReceipt({ query } as Pick<MobileSession, 'query'>, 'original-receipt'))
        .rejects.toMatchObject({ code: 'unreachable', idempotencyKey: 'original-receipt', retryable: false })
    },
  )

  it.each(['not_found', 'conflict', 'access_revoked', 'unsupported_capability', 'unreachable'] as const)(
    'cannot infer nonexecution from %s', async (code) => {
      const query = vi.fn().mockRejectedValue(new RemoteError(code, 'Host receipt unavailable', 404))
      await expect(checkCommandReceipt({ query } as Pick<MobileSession, 'query'>, 'original-receipt'))
        .rejects.toMatchObject({ code: 'unreachable', idempotencyKey: 'original-receipt', retryable: false })
    },
  )
})
