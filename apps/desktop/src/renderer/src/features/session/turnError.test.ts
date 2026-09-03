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

  it('recognises an over-long conversation ahead of the transport families', () => {
    const view = classifyTurnError(
      "endpoint error 400: the conversation is longer than this model's context window — " +
        'start a new session — {"error":"prompt is too long"}',
    )
    expect(view.title).toBe('Conversation too long')
    expect(view.hint).toContain('context window')
  })

  it('recognises a failing custom endpoint after its retries ran out', () => {
    const view = classifyTurnError('endpoint error 500: Internal Server Error (5 attempts)')
    expect(view.title).toBe('Endpoint is failing')
    expect(view.hint).toContain('retries')
    expect(classifyTurnError('endpoint stream interrupted: socket hang up').title).toBe(
      'Endpoint is failing',
    )
  })

  it('does not let an endpoint quoted error body relabel the family', () => {
    // The gateway's own body is inlined into the message; a 500 stays a 500.
    expect(
      classifyTurnError('endpoint error 500: Internal Server Error — {"error":"invalid api key"}')
        .title,
    ).toBe('Endpoint is failing')
    // A real auth status still classifies as auth.
    expect(classifyTurnError('endpoint error 401: Unauthorized').title).toBe(
      'Authentication required',
    )
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

  it('recognises the harness stopping its own turn', () => {
    const limit = classifyTurnError(
      'the turn hit its 200-round step limit before the model finished; the work so far is kept — send another message to continue from here',
    )
    expect(limit.title).toBe('Turn stopped early')
    expect(limit.hint).toContain('send another message')
    expect(
      classifyTurnError(
        'the model kept repeating the same tool call (read) after being told it was looping, so the turn was stopped',
      ).title,
    ).toBe('Turn stopped early')
  })

  it('falls through with no hint for unknown failures', () => {
    expect(classifyTurnError('model returned an empty response (3 attempts)')).toEqual({
      title: 'Turn failed',
      hint: null,
    })
  })
})
