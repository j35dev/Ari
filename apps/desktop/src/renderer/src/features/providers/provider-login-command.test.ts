import { describe, expect, it } from 'vitest'
import { loginCommandLine, loginTabTitle } from './provider-login-command'

const CLAUDE = {
  command: '/usr/local/bin/node',
  args: ['/opt/acp/claude-agent-acp.js', '--cli', 'auth', 'login', '--claudeai'],
}

describe('loginCommandLine', () => {
  it('quotes every part for a POSIX shell', () => {
    expect(loginCommandLine(CLAUDE, 'darwin')).toBe(
      "'/usr/local/bin/node' '/opt/acp/claude-agent-acp.js' '--cli' 'auth' 'login' '--claudeai'",
    )
  })

  it('quotes for PowerShell and makes the quoted path the command', () => {
    expect(
      loginCommandLine({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['--cli'] }, 'win32'),
    ).toBe("& 'C:\\Program Files\\nodejs\\node.exe' '--cli'")
  })

  it('survives paths with spaces without splitting them into arguments', () => {
    const line = loginCommandLine({ command: '/Applications/My Node/node', args: [] }, 'linux')
    expect(line).toBe("'/Applications/My Node/node'")
  })

  /**
   * The argv comes from the agent over stdio, so a crafted response must not be
   * able to reach the shell as syntax. Both dialects keep it as one literal.
   */
  it('neutralizes shell metacharacters in an agent-supplied argument', () => {
    const hostile = { command: 'node', args: ["; rm -rf ~ #", '$(whoami)', '`id`', '&& shutdown'] }

    const posix = loginCommandLine(hostile, 'linux')
    expect(posix).toBe("'node' '; rm -rf ~ #' '$(whoami)' '`id`' '&& shutdown'")

    const powershell = loginCommandLine(hostile, 'win32')
    expect(powershell).toBe("& 'node' '; rm -rf ~ #' '$(whoami)' '`id`' '&& shutdown'")
  })

  it('escapes an embedded single quote per dialect', () => {
    expect(loginCommandLine({ command: 'node', args: ["it's"] }, 'linux')).toBe(
      String.raw`'node' 'it'\''s'`,
    )
    expect(loginCommandLine({ command: 'node', args: ["it's"] }, 'win32')).toBe("& 'node' 'it''s'")
  })
})

describe('loginTabTitle', () => {
  it('names the tab after the login the user picked', () => {
    expect(loginTabTitle({ name: 'Claude Subscription' })).toBe('Claude Subscription sign-in')
  })
})
