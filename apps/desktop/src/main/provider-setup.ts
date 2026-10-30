import { randomUUID } from 'node:crypto'
import { createLogger } from '@ari/shared/logger'
import type { AccountSignIn } from './provider-accounts'
import type { TerminalService } from './terminal-service'
import { loginCommandLine } from '../shared/provider-login-command'

const log = createLogger('desktop:provider-setup')

/** Opens only the provider's own login, in a host-chosen home, before any project is trusted. */
export async function openProviderSetupTerminal(deps: {
  signIn: () => Promise<AccountSignIn | null>
  terminals: Pick<TerminalService, 'create' | 'write' | 'kill'>
  homeDir: string
  platform: string
}): Promise<{ ok: true; id: string; cwd: string } | { ok: false; error: string }> {
  let id: string | null = null
  try {
    const login = await deps.signIn()
    if (login === null)
      return { ok: false, error: 'Install and enable this agent before signing in.' }
    id = `setup_${randomUUID()}`
    deps.terminals.create(id, deps.homeDir)
    deps.terminals.write(id, `${loginCommandLine(login, deps.platform, login.env)}\r`)
    return { ok: true, id, cwd: deps.homeDir }
  } catch (error) {
    if (id !== null) deps.terminals.kill(id)
    log.warn('provider setup terminal failed', { error: String(error) })
    return {
      ok: false,
      error: 'Could not open sign-in. Check the agent installation and try again.',
    }
  }
}
