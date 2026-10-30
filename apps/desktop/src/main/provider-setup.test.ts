// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { openProviderSetupTerminal } from './provider-setup'

function setup() {
  return {
    signIn: vi.fn(async () => ({
      title: 'Sign in',
      command: 'C:\\Agent Folder\\codex.cmd',
      args: ['login'],
      env: { CODEX_HOME: 'C:\\Account' },
    })),
    terminals: { create: vi.fn(), write: vi.fn(), kill: vi.fn() },
    homeDir: 'C:\\Users\\person',
    platform: 'win32',
  }
}

describe('provider setup terminal', () => {
  it('starts the native login in the host-selected home with literal quoting', async () => {
    const deps = setup()
    const result = await openProviderSetupTerminal(deps)
    expect(result).toMatchObject({ ok: true, cwd: deps.homeDir })
    if (!result.ok) throw new Error('expected setup terminal')
    expect(deps.terminals.create).toHaveBeenCalledWith(result.id, deps.homeDir)
    expect(deps.terminals.write).toHaveBeenCalledWith(
      result.id,
      "$env:CODEX_HOME = 'C:\\Account'; & 'C:\\Agent Folder\\codex.cmd' 'login'\r",
    )
  })

  it('never creates an unrestricted terminal when login is unavailable', async () => {
    const deps = setup()
    const result = await openProviderSetupTerminal({ ...deps, signIn: async () => null })
    expect(result.ok).toBe(false)
    expect(deps.terminals.create).not.toHaveBeenCalled()
  })

  it('disposes a half-created terminal on failure', async () => {
    const deps = setup()
    deps.terminals.write.mockImplementation(() => {
      throw new Error('pty exited')
    })
    expect((await openProviderSetupTerminal(deps)).ok).toBe(false)
    expect(deps.terminals.kill).toHaveBeenCalledOnce()
  })
})
