import { randomUUID } from 'node:crypto'
import { createLogger } from '@ari/shared/logger'
import type { AccountSignIn } from './provider-accounts'
import type { TerminalService } from './terminal-service'

/** cmd.exe quoting for one argv part. A name with spaces stays one argument. */
function quoteCmd(part: string): string {
  if (part.length === 0) return '""'
  if (/[\s"&|<>^]/.test(part)) return `"${part.replaceAll('"', '""')}"`
  return part
}

function spawnEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[name] = value
  }
  for (const [name, value] of Object.entries(extra)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) env[name] = value
  }
  return env
}

const log = createLogger('desktop:provider-setup')

/** Opens only the provider's own login, in a host-chosen home, before any project is trusted. */
export async function openProviderSetupTerminal(deps: {
  signIn: () => Promise<AccountSignIn | null>
  terminals: Pick<TerminalService, 'spawn' | 'kill'>
  homeDir: string
  platform: string
}): Promise<{ ok: true; id: string; cwd: string } | { ok: false; error: string }> {
  let id: string | null = null
  try {
    const login = await deps.signIn()
    if (login === null)
      return { ok: false, error: 'Install and enable this agent before signing in.' }
    id = `setup_${randomUUID()}`
    const env = spawnEnv(login.env)
    // The pty is the login program. On Windows a `.cmd` shim cannot be
    // CreateProcess'd, so cmd.exe /c runs that one command and then exits.
    // It is not an interactive shell the renderer can type new commands into.
    if (deps.platform === 'win32') {
      const line = [login.command, ...login.args].map(quoteCmd).join(' ')
      deps.terminals.spawn(id, 'cmd.exe', ['/d', '/s', '/c', line], deps.homeDir, env)
    } else {
      deps.terminals.spawn(id, login.command, login.args, deps.homeDir, env)
    }
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
