import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerConfigDir, providerConfigFile, providerConfigFiles } from './config-files'
import type { DetectEnvironment } from './types'

const ENV: DetectEnvironment = {
  platform: 'linux',
  pathEnv: '/usr/bin',
  homeDir: '/home/tester',
  vars: {},
}

describe('providerConfigFiles', () => {
  it("lists pi's settings, prompts, and models under the agent dir", () => {
    const files = providerConfigFiles('pi', ENV)
    expect(files.map((f) => f.id)).toEqual([
      'settings',
      'system',
      'append-system',
      'agents',
      'models',
      'keybindings',
    ])
    expect(files[0]?.path).toBe(join('/home/tester', '.pi', 'agent', 'settings.json'))
    expect(files[0]?.format).toBe('json')
    expect(files[1]?.format).toBe('markdown')
  })

  it('honours the env vars each vendor uses to relocate its config dir', () => {
    const vars = {
      PI_CODING_AGENT_DIR: '/elsewhere/pi',
      CLAUDE_CONFIG_DIR: '/elsewhere/claude',
      CODEX_HOME: '/elsewhere/codex',
      GROK_HOME: '/elsewhere/grok',
      OPENCODE_CONFIG_DIR: '/elsewhere/opencode',
    }
    const env = { ...ENV, vars }
    expect(providerConfigDir('pi', env)).toBe('/elsewhere/pi')
    expect(providerConfigDir('claude', env)).toBe('/elsewhere/claude')
    expect(providerConfigDir('codex', env)).toBe('/elsewhere/codex')
    expect(providerConfigDir('grok', env)).toBe('/elsewhere/grok')
    expect(providerConfigDir('opencode', env)).toBe('/elsewhere/opencode')
    expect(providerConfigFiles('pi', env)[0]?.path).toBe(join('/elsewhere/pi', 'settings.json'))
  })

  it('defaults each kind to its documented layout', () => {
    expect(providerConfigDir('claude', ENV)).toBe(join('/home/tester', '.claude'))
    expect(providerConfigDir('codex', ENV)).toBe(join('/home/tester', '.codex'))
    expect(providerConfigDir('opencode', ENV)).toBe(join('/home/tester', '.config', 'opencode'))
    expect(providerConfigDir('grok', ENV)).toBe(join('/home/tester', '.grok'))
  })

  it('answers empty for kinds whose layout Ari has not confirmed', () => {
    // Guessing a path would have Ari creating a file the agent never reads.
    expect(providerConfigFiles('hermes', ENV)).toEqual([])
    expect(providerConfigFiles('ari-core', ENV)).toEqual([])
    expect(providerConfigDir('hermes', ENV)).toBeNull()
  })

  it('answers empty when the home directory is unknown', () => {
    expect(providerConfigFiles('pi', { ...ENV, homeDir: '' })).toEqual([])
  })

  it('never exposes a credential store', () => {
    for (const kind of ['pi', 'claude', 'codex', 'opencode', 'grok'] as const) {
      const names = providerConfigFiles(kind, ENV).map((f) => f.path.toLowerCase())
      expect(names.some((n) => n.includes('auth') || n.includes('credential'))).toBe(false)
    }
  })

  it('resolves a file by id and refuses an unknown one', () => {
    expect(providerConfigFile('pi', 'settings', ENV)?.label).toBe('settings.json')
    expect(providerConfigFile('pi', 'nope', ENV)).toBeNull()
    expect(providerConfigFile('hermes', 'settings', ENV)).toBeNull()
  })
})
