import { expect, it } from 'vitest'
import { agentModelLabel } from './agent-label'

it('shortens a catalog model id and keeps a bare id', () => {
  expect(agentModelLabel('pi', 'qoder/GLM-5.3-Flash')).toBe('Pi · GLM 5.3 Flash')
  expect(agentModelLabel('codex', 'gpt-5')).toBe('Codex · gpt-5')
  expect(agentModelLabel('claude', null)).toBe('Claude')
})
