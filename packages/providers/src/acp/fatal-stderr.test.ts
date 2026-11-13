import { describe, expect, it } from 'vitest'
import { fatalAgentError } from './fatal-stderr'

const log = (error: string, extra = '') =>
  `timestamp=2026-11-13T08:26:38.683Z level=ERROR run=1 message="stream error" providerID=opencode modelID=m ${extra}error.error="${error}"`

describe('fatalAgentError', () => {
  it("returns OpenCode's own words for an exhausted free usage limit", () => {
    expect(
      fatalAgentError(
        log(
          'AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go',
        ),
      ),
    ).toBe(
      'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go',
    )
  })

  it('unwraps the retry wrapper and reads quota, credit and key failures', () => {
    expect(
      fatalAgentError(
        log('AI_RetryError: Failed after 3 attempts. Last error: You exceeded your current quota'),
      ),
    ).toBe('You exceeded your current quota')
    expect(fatalAgentError(log('AI_APICallError: Insufficient credits'))).toBe(
      'Insufficient credits',
    )
    expect(fatalAgentError(log('AI_APICallError: Invalid API key provided'))).toBe(
      'Invalid API key provided',
    )
  })

  it('leaves transient rate limits to the agent to retry', () => {
    expect(fatalAgentError(log('AI_APICallError: Rate limit exceeded, retry in 20s'))).toBeNull()
    expect(fatalAgentError(log('AI_APICallError: Overloaded'))).toBeNull()
  })

  it('ignores errors that are not a failed model call', () => {
    // An MCP server's auth failure must not end a healthy turn.
    expect(
      fatalAgentError(
        'timestamp=2026-11-13T08:00:00.000Z level=ERROR service=mcp message="connect failed" error="Unauthorized"',
      ),
    ).toBeNull()
    expect(fatalAgentError('npm WARN deprecated quota-tracker@1.0.0')).toBeNull()
  })
})
