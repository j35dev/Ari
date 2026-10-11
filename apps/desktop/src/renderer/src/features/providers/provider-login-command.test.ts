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

  it('sets an account’s home for that one command, quoted like everything else', () => {
    const login = { command: 'claude', args: ['auth', 'login'] }
    expect(loginCommandLine(login, 'linux', { CLAUDE_CONFIG_DIR: "/home/o'neil/acct; rm -rf ~" })).toBe(
      String.raw`CLAUDE_CONFIG_DIR='/home/o'\''neil/acct; rm -rf ~' 'claude' 'auth' 'login'`,
    )
    expect(loginCommandLine(login, 'win32', { CODEX_HOME: 'C:\\Users\\a b\\acct' })).toBe(
      "$env:CODEX_HOME = 'C:\\Users\\a b\\acct'; & 'claude' 'auth' 'login'",
    )
  })

  it('does not let a typographic quote in a Windows path end the string', () => {
    // PowerShell closes a single-quoted string at U+2019 as readily as at '.
    const home = 'C:\\Users\\D\u2019Arcy; calc\\acct'
    expect(loginCommandLine({ command: 'claude', args: [] }, 'win32', { CODEX_HOME: home })).toBe(
      "$env:CODEX_HOME = 'C:\\Users\\D\u2019\u2019Arcy; calc\\acct'; & 'claude'",
    )
  })

  it('drops a variable whose name could not be written safely', () => {
    const login = { command: 'claude', args: [] }
    expect(loginCommandLine(login, 'linux', { 'X; rm -rf ~': 'v', OK_1: 'v' })).toBe(
      "OK_1='v' 'claude'",
    )
  })
})

describe('loginTabTitle', () => {
  it('names the tab after the login the user picked', () => {
    expect(loginTabTitle({ name: 'Claude Subscription' })).toBe('Claude Subscription sign-in')
  })
})
