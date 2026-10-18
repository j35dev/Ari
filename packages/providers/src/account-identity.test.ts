import { describe, expect, it } from 'vitest'
import { accountLoginArgs, parseClaudeIdentity, parseCodexIdentity } from './account-identity'

describe('parseClaudeIdentity', () => {
  it('reads the email and plan of a subscription sign-in', () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'dev@example.com',
      orgName: 'Example',
      subscriptionType: 'max',
    })
    expect(parseClaudeIdentity(stdout)).toEqual({
      signedIn: true,
      email: 'dev@example.com',
      plan: 'max',
    })
  })

  it('names the method when there is no subscription behind the sign-in', () => {
    expect(parseClaudeIdentity(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }))).toEqual({
      signedIn: true,
      email: null,
      plan: 'api_key',
    })
  })

  it('reports signed out, which the CLI says with a non-zero exit and the same JSON', () => {
    expect(parseClaudeIdentity(JSON.stringify({ loggedIn: false, authMethod: 'none' }))).toEqual({
      signedIn: false,
      email: null,
      plan: null,
    })
  })

  it('answers unknown, not signed out, for output it cannot read', () => {
    expect(parseClaudeIdentity('')).toBeNull()
    expect(parseClaudeIdentity('Not logged in')).toBeNull()
    expect(parseClaudeIdentity('{"version":"2.1.0"}')).toBeNull()
    expect(parseClaudeIdentity('null')).toBeNull()
  })
})

describe('parseCodexIdentity', () => {
  it('reads a ChatGPT account', () => {
    expect(
      parseCodexIdentity({
        account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ signedIn: true, email: 'dev@example.com', plan: 'plus' })
  })

  it('falls back to the account type for an API key', () => {
    expect(parseCodexIdentity({ account: { type: 'apiKey' } })).toEqual({
      signedIn: true,
      email: null,
      plan: 'apiKey',
    })
  })

  it('reports signed out for a null account and unknown for anything else', () => {
    expect(parseCodexIdentity({ account: null, requiresOpenaiAuth: true })).toEqual({
      signedIn: false,
      email: null,
      plan: null,
    })
    expect(parseCodexIdentity({})).toBeNull()
    expect(parseCodexIdentity(null)).toBeNull()
    expect(parseCodexIdentity({ account: 'chatgpt' })).toBeNull()
  })
})

describe('accountLoginArgs', () => {
  it('knows the sign-in command of the providers that have accounts', () => {
    expect(accountLoginArgs('claude')).toEqual(['auth', 'login'])
    expect(accountLoginArgs('codex')).toEqual(['login'])
    expect(accountLoginArgs('grok')).toBeNull()
  })
})
