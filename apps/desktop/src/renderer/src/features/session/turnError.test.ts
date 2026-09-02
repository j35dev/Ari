import { describe, expect, it } from 'vitest'
import { classifyTurnError } from './turnError'

describe('classifyTurnError', () => {
  it('recognises auth failures with a login hint', () => {
    const view = classifyTurnError(
      'claude is not authenticated yet — run its login flow once in a terminal, then retry',
    )
    expect(view.title).toBe('Authentication required')
    expect(view.hint).toContain('login flow')
  })

  it('classifies stall watchdog failures as timeouts, not auth', () => {
    // The watchdog's message ends "…may be wedged or waiting for login"; the
    // bare word "login" must not flip it into the auth family.
    const view = classifyTurnError(
      'claude (ACP adapter @agentclientprotocol/claude-agent-acp@0.70.0) went silent for 120s mid-session/prompt — the agent may be wedged or waiting for login',
    )
    expect(view.title).toBe('Agent timed out')
    expect(view.hint).toContain('stopped responding')
  })

  it('still recognises sign-in phrasing without "login flow"', () => {
    expect(classifyTurnError('claude needs you to sign in again').title).toBe(
      'Authentication required',
    )
  })

  it('recognises rate limits and quota', () => {
    expect(classifyTurnError('429 too many requests').title).toBe('Provider is throttling')
    expect(classifyTurnError('insufficient credits').title).toBe('Provider is throttling')
  })

  it('recognises spawn failures and missing binaries', () => {
    const view = classifyTurnError(
      "spawn npx ENOENT: 'ari-missing-bin' is not recognized as an internal or external command",
    )
    expect(view.title).toBe('Agent could not start')
    expect(view.hint).toContain('PATH')
  })

  it('recognises timeouts and stalls', () => {
    expect(classifyTurnError('produced no output within 120s').title).toBe('Agent timed out')
    expect(classifyTurnError('handshake failed').title).toBe('Agent timed out')
  })

  it('recognises network failures', () => {
    expect(classifyTurnError('getaddrinfo ENOTFOUND api.example.com').title).toBe('Network error')
  })

  it('falls through with no hint for unknown failures', () => {
    expect(classifyTurnError('model returned an empty response (3 attempts)')).toEqual({
      title: 'Turn failed',
      hint: null,
    })
  })
})
