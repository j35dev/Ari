import { describe, expect, it } from 'vitest'
import { RemoteError } from './gateway-client'
import { closeRemoteTerminal } from './terminal-close'

describe('terminal recovery after a desktop restart', () => {
  it('allows forgetting the shell reference when the computer confirms it is already gone', async () => {
    await expect(
      closeRemoteTerminal(() =>
        Promise.reject(new RemoteError('not_found', 'terminal unavailable')),
      ),
    ).resolves.toBeUndefined()
  })
  it('retains the reference when a kill acknowledgement is uncertain or authorization fails', async () => {
    for (const code of ['unreachable', 'unauthenticated'] as const) {
      const failure = new RemoteError(code, 'not confirmed')
      await expect(closeRemoteTerminal(() => Promise.reject(failure))).rejects.toBe(failure)
    }
  })
})
