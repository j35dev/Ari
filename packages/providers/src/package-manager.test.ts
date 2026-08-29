import { describe, expect, it } from 'vitest'
import { inferManager, planFor } from './package-manager'

describe('inferManager', () => {
  it('infers npm from the win32 global prefix layout', () => {
    expect(inferManager('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', 'codex')).toBe('npm')
  })

  it('infers pnpm and bun global dirs', () => {
    expect(inferManager('C:\\Users\\u\\AppData\\Local\\pnpm\\opencode.exe', 'opencode')).toBe('pnpm')
    expect(inferManager('/Users/u/.bun/bin/opencode', 'opencode')).toBe('bun')
  })

  it('infers homebrew from a Cellar path on darwin', () => {
    expect(inferManager('/opt/homebrew/Cellar/opencode/1.2.0/bin/opencode', 'opencode')).toBe('brew')
  })

  it('infers npm from a linux nvm path', () => {
    expect(inferManager('/home/u/.nvm/versions/node/v22.3.0/bin/claude', 'claude')).toBe('npm')
  })

  it('reports native for self-updating CLIs regardless of path', () => {
    expect(inferManager('C:\\Users\\u\\.grok\\bin\\grok.exe', 'grok')).toBe('native')
    expect(inferManager('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe', 'hermes')).toBe(
      'native',
    )
  })

  it('falls back to npm for npm-distributed kinds in unknown dirs', () => {
    expect(inferManager('/home/u/.local/bin/claude', 'claude')).toBe('npm')
    expect(inferManager(null, 'pi')).toBe('npm')
  })
})

describe('planFor', () => {
  it('builds argv arrays, never shell strings', () => {
    const plan = planFor('codex', 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')
    expect(plan?.installCommand).toEqual([
      'npm',
      'install',
      '-g',
      '--allow-scripts=@openai/codex',
      '@openai/codex',
    ])
    expect(plan?.upgradeCommand).toEqual([
      'npm',
      'install',
      '-g',
      '--allow-scripts=@openai/codex',
      '@openai/codex@latest',
    ])
    expect(plan?.installCommand.every((part) => !part.includes('&&'))).toBe(true)
  })

  it('uses pnpm/bun verbs for their global dirs', () => {
    expect(planFor('opencode', '/Users/u/.bun/bin/opencode')?.upgradeCommand).toEqual([
      'bun',
      'add',
      '-g',
      'opencode-ai@latest',
    ])
    expect(planFor('pi', 'C:\\Users\\u\\AppData\\Local\\pnpm\\pi.exe')?.installCommand).toEqual([
      'pnpm',
      'add',
      '-g',
      '@earendil-works/pi-coding-agent',
    ])
  })

  it('strips the npm scope for homebrew formulae', () => {
    expect(planFor('claude', '/opt/homebrew/Cellar/claude-code/1.0/bin/claude')?.upgradeCommand).toEqual([
      'brew',
      'upgrade',
      'claude-code',
    ])
  })

  it('uses vendor self-upgrade for grok and hermes', () => {
    expect(planFor('grok', 'C:\\Users\\u\\.grok\\bin\\grok.exe')?.upgradeCommand).toEqual([
      'grok',
      'update',
    ])
    const hermes = planFor('hermes', null)
    expect(hermes?.manager).toBe('native')
    expect(hermes?.upgradeCommand).toEqual(['hermes', 'update'])
    expect(hermes?.installCommand[0]).toBe('uv')
  })

  it('exposes a display string matching the upgrade argv', () => {
    const plan = planFor('codex', null)
    expect(plan?.display).toBe(plan?.upgradeCommand.join(' '))
  })

  it('has no plan for the built-in core', () => {
    expect(planFor('ari-core', null)).toBeNull()
  })
})
