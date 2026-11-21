import { describe, expect, it } from 'vitest'
import { inferManager, planFor } from './package-manager'

describe('inferManager', () => {
  it('infers npm from the win32 global prefix layout', () => {
    expect(inferManager('C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd', 'codex')).toBe('npm')
  })

  it('infers pnpm and bun global dirs', () => {
    expect(inferManager('C:\\Users\\u\\AppData\\Local\\pnpm\\opencode.exe', 'opencode')).toBe(
      'pnpm',
    )
    expect(inferManager('/Users/u/.bun/bin/opencode', 'opencode')).toBe('bun')
  })

  it('infers homebrew from a Cellar path on darwin', () => {
    expect(inferManager('/opt/homebrew/Cellar/opencode/1.2.0/bin/opencode', 'opencode')).toBe(
      'brew',
    )
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

  it('does not mistake native or unknown installs for npm', () => {
    expect(inferManager('/home/u/.local/bin/claude', 'claude')).toBe('native')
    expect(inferManager('C:\\Users\\u\\.local\\bin\\claude.exe', 'claude')).toBe('native')
    expect(inferManager('C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd', 'pi')).toBe('native')
    expect(inferManager('/somewhere/codex', 'codex')).toBe('native')
    expect(inferManager(null, 'pi')).toBe('npm')
  })
})

describe('planFor', () => {
  it('uses vendor installers for native Qoder and Muse instead of guessing npm packages', () => {
    expect(planFor('qoder', null, 'linux')?.installCommand).toEqual([
      'bash',
      '-c',
      'curl -fsSL https://qoder.com/install | bash',
    ])
    expect(planFor('muse', null, 'win32')?.installCommand).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Invoke-RestMethod 'https://dev.meta.ai/install.ps1' | Invoke-Expression",
    ])
    expect(planFor('qoder', '/opt/qodercli', 'linux')?.upgradeCommand).toEqual([
      '/opt/qodercli',
      'update',
    ])
    const muse = planFor('muse', null, 'linux')
    expect(muse?.upgradeCommand).toEqual(muse?.installCommand)
  })
  it('builds argv arrays, never shell strings', () => {
    const plan = planFor('codex', 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd')
    expect(plan?.installCommand).toEqual([
      'npm',
      'install',
      '-g',
      '--ignore-scripts=false',
      '--prefix',
      'C:\\Users\\u\\AppData\\Roaming\\npm',
      '@openai/codex',
    ])
    expect(plan?.upgradeCommand).toEqual([
      'npm',
      'install',
      '-g',
      '--ignore-scripts=false',
      '--prefix',
      'C:\\Users\\u\\AppData\\Roaming\\npm',
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
    expect(
      planFor('claude', '/opt/homebrew/Cellar/claude-code/1.0/bin/claude')?.upgradeCommand,
    ).toEqual(['brew', 'upgrade', 'claude-code'])
  })

  it('uses vendor self-upgrade for grok and hermes', () => {
    expect(planFor('grok', 'C:\\Users\\u\\.grok\\bin\\grok.exe')?.upgradeCommand).toEqual([
      'C:\\Users\\u\\.grok\\bin\\grok.exe',
      'update',
    ])
    const hermes = planFor('hermes', null)
    expect(hermes?.manager).toBe('native')
    expect(hermes?.upgradeCommand).toEqual(['hermes', 'update'])
    expect(hermes?.installCommand[0]).toBe(process.platform === 'win32' ? 'powershell.exe' : 'bash')
  })

  it('exposes a display string matching the upgrade argv', () => {
    const plan = planFor('codex', null)
    expect(plan?.display).toBe(plan?.upgradeCommand.join(' '))
  })

  it('has no plan for the built-in core', () => {
    expect(planFor('ari-core', null)).toBeNull()
  })

  it.each([
    [
      'claude',
      'C:\\Users\\u\\.local\\bin\\claude.exe',
      ['C:\\Users\\u\\.local\\bin\\claude.exe', 'update'],
    ],
    [
      'qoder',
      'C:\\Users\\u\\.qoder\\bin\\qodercli.exe',
      ['C:\\Users\\u\\.qoder\\bin\\qodercli.exe', 'update'],
    ],
    [
      'pi',
      'C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd',
      ['C:\\Users\\u\\.pi\\agent\\bin\\pi.cmd', 'update', '--self'],
    ],
    [
      'hermes',
      'C:\\Users\\u\\.local\\bin\\hermes.exe',
      ['C:\\Users\\u\\.local\\bin\\hermes.exe', 'update'],
    ],
    [
      'opencode',
      'C:\\Users\\u\\.opencode\\bin\\opencode.exe',
      ['C:\\Users\\u\\.opencode\\bin\\opencode.exe', 'upgrade'],
    ],
  ] as const)('uses the selected native %s updater on Windows', (kind, path, command) => {
    expect(planFor(kind, path, 'win32')?.upgradeCommand).toEqual(command)
  })

  it('uses the Grok PowerShell installer without sh on Windows', () => {
    expect(planFor('grok', null, 'win32')?.installCommand).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Invoke-RestMethod 'https://x.ai/cli/install.ps1' | Invoke-Expression",
    ])
  })

  it('keeps npm, uv, Scoop and WinGet installs on their actual channel', () => {
    expect(planFor('grok', 'C:/Users/u/AppData/Roaming/npm/grok.cmd', 'win32')?.manager).toBe('npm')
    expect(
      planFor('hermes', 'C:/Users/u/.local/share/uv/tools/hermes-cli/Scripts/hermes.exe', 'win32')
        ?.upgradeCommand,
    ).toEqual(['uv', 'tool', 'upgrade', 'hermes-cli'])
    expect(
      planFor('claude', 'C:/Users/u/scoop/apps/claude-code/current/claude.exe', 'win32')
        ?.upgradeCommand,
    ).toEqual(['scoop', 'update', 'claude-code'])
    expect(
      planFor(
        'codex',
        'C:/Users/u/AppData/Local/Microsoft/WinGet/Packages/OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe/codex.exe',
        'win32',
      )?.upgradeCommand,
    ).toEqual(['winget', 'upgrade', '--id', 'OpenAI.Codex', '--exact', '--disable-interactivity'])
    expect(planFor('codex', 'C:/unknown/codex.exe', 'win32')).toBeNull()
  })

  it('targets the owning npm prefix when the selected executable is inside its package', () => {
    expect(
      planFor(
        'codex',
        'C:/Users/u/AppData/Roaming/npm/node_modules/@openai/codex/vendor/codex.exe',
        'win32',
      )?.upgradeCommand,
    ).toContain('C:/Users/u/AppData/Roaming/npm')
    expect(
      planFor('claude', '/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'linux')
        ?.upgradeCommand,
    ).toContain('/opt/node')
  })

  it('keeps Homebrew casks on the cask channel', () => {
    expect(
      planFor('codex', '/opt/homebrew/Caskroom/codex/0.1/codex', 'darwin')?.upgradeCommand,
    ).toEqual(['brew', 'upgrade', '--cask', 'codex'])
  })
})
