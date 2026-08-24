import { describe, expect, it } from 'vitest'
import { agentMark, driverLabel, kindFromGroup } from './agent-mark'

describe('agentMark', () => {
  it('maps known agents to a single letter', () => {
    expect(agentMark('claude')).toBe('C')
    expect(agentMark('codex')).toBe('X')
    expect(agentMark('opencode')).toBe('O')
    expect(agentMark('ari-core')).toBe('A')
    expect(agentMark('Ari Core')).toBe('A')
  })

  it('falls back to the first character for unknown kinds', () => {
    expect(agentMark('grok')).toBe('G')
    expect(agentMark('')).toBe('?')
  })
})

describe('driverLabel', () => {
  it('title-cases known kinds and keeps unknown ids', () => {
    expect(driverLabel('claude')).toBe('Claude')
    expect(driverLabel('ari-core')).toBe('Ari Core')
    expect(driverLabel('mystery')).toBe('mystery')
  })
})

describe('kindFromGroup', () => {
  it('round-trips picker group labels', () => {
    expect(kindFromGroup('Ari Core')).toBe('ari-core')
    expect(kindFromGroup('claude')).toBe('claude')
  })
})
