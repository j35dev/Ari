import { describe, expect, it } from 'vitest'
import { configProblem, jsonProblem, tomlProblem } from './config-validate'

describe('jsonProblem', () => {
  it('accepts valid and empty JSON', () => {
    expect(jsonProblem('{"model":"opus"}')).toBeNull()
    expect(jsonProblem('  \n')).toBeNull()
  })

  it('points at the line of a syntax error', () => {
    const problem = jsonProblem('{\n  "model": "opus",\n}')
    expect(problem?.message).toBeTruthy()
    expect(problem?.message).not.toMatch(/position \d+/)
    expect(problem?.line).toBe(3)
  })

  it('reports a truncated document', () => {
    expect(jsonProblem('{"a": [1, 2')?.message).toBeTruthy()
  })
})

describe('tomlProblem', () => {
  it('accepts a real Codex config', () => {
    const toml = [
      'model = "gpt-5" # the default',
      'model_reasoning_effort = "high"',
      'approval_policy = "on-request"',
      'max_tokens = 1_000',
      'temperature = 0.5',
      'started = 2026-11-21T10:00:00Z',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = [',
      '  "-y", # comment',
      '  "docs-mcp",',
      ']',
      'env = { "API_KEY" = "x", REGION = "eu" }',
      '',
      '[[skills.config]]',
      'path = "/a"',
      'enabled = false',
      '[[skills.config]]',
      'path = "/b"',
      '[profiles.fast]',
      "notes = '''",
      'multi [ line',
      "'''",
      'url = "https://x.dev/#anchor"',
    ].join('\n')
    expect(tomlProblem(toml)).toBeNull()
  })

  it('flags an unquoted string with its line', () => {
    expect(tomlProblem('a = 1\nmodel = gpt-5')).toMatchObject({ line: 2 })
    expect(tomlProblem('model = gpt-5')?.message).toMatch(/quotes/)
  })

  it('flags unterminated strings, brackets and headers', () => {
    expect(tomlProblem('model = "gpt-5')).toMatchObject({ message: 'Unterminated string', line: 1 })
    expect(tomlProblem('args = [\n "a",\n')).toMatchObject({ message: 'Unclosed [ or {', line: 1 })
    expect(tomlProblem('[mcp_servers.docs')).toMatchObject({ line: 1 })
    expect(tomlProblem('just words')).toMatchObject({ message: 'Expected key = value' })
  })

  it('flags a table or key defined twice', () => {
    expect(tomlProblem('[a]\nx = 1\n[a]')?.message).toMatch(/twice/)
    expect(tomlProblem('x = 1\nx = 2')).toMatchObject({ line: 2 })
  })
})

describe('configProblem', () => {
  it('leaves markdown alone', () => {
    expect(configProblem('markdown', '{ not json')).toBeNull()
    expect(configProblem('json', '{')).not.toBeNull()
  })
})
