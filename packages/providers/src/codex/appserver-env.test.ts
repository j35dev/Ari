import { describe, expect, it } from 'vitest'
import { AppServerConnection } from './appserver-connection'
import { CodexDriver } from './codex-driver'

describe('codex app-server env', () => {
  it('passes runtimeEnv into the spawn callback', () => {
    let seen: Record<string, string | undefined> | undefined
    expect(() =>
      AppServerConnection.start({
        binaryPath: 'codex',
        cwd: 'D:\\proj',
        env: { CODEX_HOME: 'D:\\home\\.codex' },
        spawn: (_binary, cwd, env) => {
          seen = env
          expect(cwd).toBe('D:\\proj')
          throw new Error('stop')
        },
      }),
    ).toThrow(/failed to spawn/)
    expect(seen).toEqual({ CODEX_HOME: 'D:\\home\\.codex' })
  })

  it('threads session.runtimeEnv through CodexDriver', async () => {
    let seen: Record<string, string | undefined> | undefined
    const driver = new CodexDriver('codex', {
      probe: { supportsAppServer: () => Promise.resolve(true) },
      spawnAppServer: (_binary, _cwd, env) => {
        seen = env
        throw new Error('stop')
      },
      spawnLegacy: () => {
        throw new Error('legacy')
      },
    })
    await expect(
      driver.create({
        sessionId: 's',
        workspacePath: 'D:\\proj',
        prompt: 'hi',
        modelId: null,
        permissionMode: 'ask',
        resumeOf: null,
        runtimeEnv: { CODEX_HOME: 'D:\\home\\.codex' },
      }),
    ).rejects.toThrow('legacy')
    expect(seen).toEqual({ CODEX_HOME: 'D:\\home\\.codex' })
  })
})
