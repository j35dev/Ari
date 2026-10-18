import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { Settings, SettingsUpdate } from '@ari/contracts/settings'
import { ProvidersView } from './ProvidersView'
import type { Detection } from './provider-status'

const { invokeFn, subscribeFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  subscribeFn: vi.fn<(name: string, params: unknown, cb: (payload: unknown) => void) => () => void>(
    () => () => undefined,
  ),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: subscribeFn,
  },
}))

const absent = (kind: string): Detection => ({
  kind,
  enabled: true,
  installed: false,
  binaryPath: null,
  version: null,
  authStatus: 'unknown',
  candidates: [],
})

const CLAUDE: Detection = {
  kind: 'claude',
  enabled: true,
  installed: true,
  binaryPath: '/opt/native/claude',
  version: '2.1.0 (Claude Code)',
  authStatus: 'authenticated',
  pathSource: 'auto',
  candidates: ['/opt/native/claude', '/opt/npm/claude'],
  transport: { mode: 'acp', label: 'ACP adapter claude-agent-acp@0.70.0' },
}

const DETECTIONS: Detection[] = [
  CLAUDE,
  absent('codex'),
  {
    kind: 'opencode',
    enabled: true,
    installed: true,
    binaryPath: '/usr/local/bin/opencode',
    version: '0.4.2',
    authStatus: 'unknown',
    authReason: 'No opencode auth.json found; opencode can also read provider keys from the environment.',
    pathSource: 'auto',
    candidates: ['/usr/local/bin/opencode'],
  },
  absent('grok'),
  {
    kind: 'pi',
    enabled: true,
    installed: true,
    binaryPath: '/usr/local/bin/pi',
    version: '0.9.0',
    authStatus: 'authenticated',
    latestVersion: '1.0.0',
    updateAvailable: true,
    candidates: ['/usr/local/bin/pi'],
  },
  absent('hermes'),
  { kind: 'ari-core', installed: true, binaryPath: null, version: null, authStatus: 'authenticated' },
]

let detections: Detection[]
let settings: Settings
/** Answers for calls a single test cares about, keyed by RPC method. */
let answers: Record<string, unknown>

/**
 * The view holds more than one `providers.updates` subscription (installs and
 * sign-in state), and the real registry delivers each frame to all of them.
 * Returns a publish function that does the same.
 */
function captureSubscribers(): (payload: unknown) => void {
  const listeners: ((payload: unknown) => void)[] = []
  subscribeFn.mockImplementation((_name: string, _params: unknown, cb: (payload: unknown) => void) => {
    listeners.push(cb)
    return () => {
      const at = listeners.indexOf(cb)
      if (at !== -1) listeners.splice(at, 1)
    }
  })
  return (payload) => {
    act(() => {
      for (const listener of [...listeners]) listener(payload)
    })
  }
}

function list(): HTMLElement {
  return screen.getByRole('list', { name: 'Providers' })
}

function rowFor(name: string): HTMLElement {
  const row = within(list())
    .getByRole('button', { name: new RegExp(`^${name},`) })
    .closest('li')
  if (row === null) throw new Error(`No row for ${name}`)
  return row
}

function editorFor(name: string): HTMLElement {
  return screen.getByRole('group', { name: `${name} settings` })
}

async function open(name: string): Promise<HTMLElement> {
  await userEvent.click(within(rowFor(name)).getByRole('button', { name: new RegExp(`^${name},`) }))
  return editorFor(name)
}

async function renderLoaded(props: Parameters<typeof ProvidersView>[0] = {}): Promise<void> {
  render(<ProvidersView {...props} />)
  await within(rowFor('Ari Core')).findByText('Built in')
  await waitFor(() => expect(within(list()).queryByText('Checking')).toBeNull())
}

describe('ProvidersView', () => {
  beforeEach(() => {
    detections = DETECTIONS
    settings = structuredClone(defaultSettings)
    answers = {}
    subscribeFn.mockReset()
    subscribeFn.mockImplementation(() => () => undefined)
    invokeFn.mockReset()
    invokeFn.mockImplementation((method: string, params?: unknown) => {
      if (method === 'settings.get') return Promise.resolve(settings)
      if (method === 'settings.update') {
        const patch = (params as SettingsUpdate).providers ?? {}
        const providers = { ...settings.providers }
        for (const kind of Object.keys(patch) as (keyof typeof providers)[]) {
          providers[kind] = { ...providers[kind], ...patch[kind] }
        }
        settings = { ...settings, providers }
        return Promise.resolve(settings)
      }
      if (method === 'providers.detect' || method === 'providers.rescan') {
        return Promise.resolve(detections)
      }
      if (method in answers) return Promise.resolve(answers[method])
      // Accounts have their own tests; here no provider offers any.
      if (method === 'providers.accounts') return Promise.resolve({ supported: false, accounts: [] })
      return Promise.reject(new Error(`unexpected rpc: ${method}`))
    })
  })

  it('lists every provider with its version, state and switch', async () => {
    await renderLoaded()

    const claude = rowFor('Claude')
    expect(within(claude).getByText('v2.1.0')).toBeInTheDocument()
    expect(within(claude).getByText('Ready')).toBeInTheDocument()
    expect(within(claude).getByRole('switch', { name: 'Enable Claude' })).toBeChecked()

    expect(within(rowFor('Codex')).getByText('Not installed')).toBeInTheDocument()
    expect(within(rowFor('OpenCode')).getByText('Installed')).toBeInTheDocument()
    expect(within(rowFor('Pi')).getByText('Update available')).toBeInTheDocument()
    // Ari Core is part of Ari: there is nothing to turn off.
    expect(within(rowFor('Ari Core')).queryByRole('switch')).toBeNull()
  })

  it('shows which install the selected provider runs and how Ari reaches it', async () => {
    await renderLoaded()
    const editor = editorFor('Claude')

    const path = within(editor).getByLabelText('Binary path')
    expect(path).toHaveValue('')
    expect(path).toHaveAttribute('placeholder', '/opt/native/claude')
    expect(within(editor).getByText('Found on PATH.')).toBeInTheDocument()
    expect(within(editor).getByText('ACP adapter claude-agent-acp@0.70.0')).toBeInTheDocument()
    expect(within(editor).getByText('2.1.0 (Claude Code)')).toBeInTheDocument()
  })

  it('opens on the provider that needs the user', async () => {
    detections = DETECTIONS.map((d) =>
      d.kind === 'opencode' ? { ...d, authStatus: 'unauthenticated', authReason: 'Run opencode auth login.' } : d,
    )
    await renderLoaded()

    expect(within(rowFor('OpenCode')).getByText('Not signed in')).toBeInTheDocument()
    // The selection follows the first detection round, one render later.
    const editor = await screen.findByRole('group', { name: 'OpenCode settings' })
    expect(within(editor).getByText(/Run opencode auth login\./)).toBeInTheDocument()
  })

  it('turns a provider off and says so before detection catches up', async () => {
    await renderLoaded()
    const toggle = within(rowFor('Claude')).getByRole('switch', { name: 'Enable Claude' })
    await userEvent.click(toggle)

    expect(invokeFn).toHaveBeenCalledWith('settings.update', {
      providers: { claude: { enabled: false } },
    })
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(within(rowFor('Claude')).getByText('Off')).toBeInTheDocument()
    expect(within(rowFor('Claude')).queryByText('v2.1.0')).toBeNull()
    const editor = editorFor('Claude')
    expect(within(editor).getByText(/Claude is off\./)).toBeInTheDocument()
    expect(within(editor).queryByRole('button', { name: /Check sign-in/ })).toBeNull()
  })

  it('checks a provider again when it is turned back on', async () => {
    const publish = captureSubscribers()
    settings.providers.claude.enabled = false
    detections = DETECTIONS.map((d) =>
      d.kind === 'claude' ? { ...absent('claude'), enabled: false, candidates: CLAUDE.candidates } : d,
    )
    await renderLoaded()
    expect(within(rowFor('Claude')).getByText('Off')).toBeInTheDocument()

    await userEvent.click(within(rowFor('Claude')).getByRole('switch', { name: 'Enable Claude' }))
    expect(await within(rowFor('Claude')).findByText('Checking')).toBeInTheDocument()

    publish({ type: 'detections', detections: DETECTIONS })
    expect(await within(rowFor('Claude')).findByText('Ready')).toBeInTheDocument()
  })

  it('saves a typed path on Enter and reports what detection makes of it', async () => {
    const publish = captureSubscribers()
    await renderLoaded()
    const editor = await open('Codex')
    const path = within(editor).getByLabelText('Binary path')

    await userEvent.type(path, '/tools/codex{Enter}')
    expect(invokeFn).toHaveBeenCalledWith('settings.update', {
      providers: { codex: { binaryPath: '/tools/codex' } },
    })
    expect(await within(editor).findByText('Checking…', { selector: 'p' })).toBeInTheDocument()

    publish({
      type: 'detections',
      detections: DETECTIONS.map((d) =>
        d.kind === 'codex'
          ? { ...d, pathSource: 'custom', pathProblem: 'No file exists at this path.' }
          : d,
      ),
    })
    expect(await within(editor).findByRole('alert')).toHaveTextContent('No file exists at this path.')
    expect(path).toHaveAttribute('aria-invalid', 'true')
    expect(within(rowFor('Codex')).getByText('Path not usable')).toBeInTheDocument()
    // Installing would not fix a path the user chose; clearing it would.
    expect(within(editor).queryByRole('button', { name: 'Install' })).toBeNull()

    await userEvent.click(within(editor).getByRole('button', { name: 'Reset' }))
    expect(invokeFn).toHaveBeenCalledWith('settings.update', { providers: { codex: { binaryPath: '' } } })
  })

  it('keeps waiting when a round about another provider reports first', async () => {
    const publish = captureSubscribers()
    await renderLoaded()
    const editor = await open('Codex')
    await userEvent.type(within(editor).getByLabelText('Binary path'), '/tools/codex{Enter}')
    await within(rowFor('Codex')).findByText('Checking')

    // Claude's round, and a refresh of update info, say nothing about Codex.
    publish({ type: 'detections', detections: DETECTIONS, checked: ['claude'] })
    publish({ type: 'detections', detections: DETECTIONS, checked: [] })
    expect(within(rowFor('Codex')).getByText('Checking')).toBeInTheDocument()

    publish({
      type: 'detections',
      checked: ['codex'],
      detections: DETECTIONS.map((d) =>
        d.kind === 'codex' ? { ...CLAUDE, kind: 'codex', pathSource: 'custom' } : d,
      ),
    })
    expect(await within(rowFor('Codex')).findByText('Ready')).toBeInTheDocument()
  })

  it('saves a path once when Enter is followed by leaving the field', async () => {
    await renderLoaded()
    const path = within(editorFor('Claude')).getByLabelText('Binary path')

    await userEvent.type(path, '/opt/npm/claude{Enter}')
    await userEvent.tab()

    const saves = invokeFn.mock.calls.filter(([method]) => method === 'settings.update')
    expect(saves).toHaveLength(1)
  })

  it('saves nothing for a draft that was abandoned or never changed', async () => {
    await renderLoaded()
    const path = within(editorFor('Claude')).getByLabelText('Binary path')

    await userEvent.type(path, '/somewhere/else{Escape}')
    expect(path).toHaveValue('')
    await userEvent.click(path)
    await userEvent.tab()

    expect(invokeFn).not.toHaveBeenCalledWith('settings.update', expect.anything())
  })

  it('takes a path from the system file picker', async () => {
    answers['dialog.pickFile'] = { path: '/picked/claude' }
    await renderLoaded()

    await userEvent.click(within(editorFor('Claude')).getByRole('button', { name: 'Browse' }))

    expect(invokeFn).toHaveBeenCalledWith('dialog.pickFile', { defaultPath: '/opt/native/claude' })
    await waitFor(() =>
      expect(invokeFn).toHaveBeenCalledWith('settings.update', {
        providers: { claude: { binaryPath: '/picked/claude' } },
      }),
    )
  })

  it('lists the other installs on the machine and pins the one chosen', async () => {
    await renderLoaded()
    const editor = editorFor('Claude')
    const native = within(editor).getByText('/opt/native/claude').closest('li') as HTMLElement
    expect(within(native).getByText('In use')).toBeInTheDocument()

    await userEvent.click(within(editor).getByRole('button', { name: 'Use /opt/npm/claude' }))
    expect(invokeFn).toHaveBeenCalledWith('settings.update', {
      providers: { claude: { binaryPath: '/opt/npm/claude' } },
    })

    // Going back to the first one on PATH means going back to automatic.
    await userEvent.click(await within(editor).findByRole('button', { name: 'Use /opt/native/claude' }))
    expect(invokeFn).toHaveBeenLastCalledWith('settings.update', {
      providers: { claude: { binaryPath: '' } },
    })
  })

  it('installs a missing provider and updates a stale one without a command dump', async () => {
    answers['providers.install'] = { started: true }
    await renderLoaded()

    const codex = await open('Codex')
    expect(within(codex).queryByRole('button', { name: 'Update' })).toBeNull()
    await userEvent.click(within(codex).getByRole('button', { name: 'Install' }))
    expect(invokeFn).toHaveBeenCalledWith('providers.install', { kind: 'codex', operation: 'install' })
    expect(await within(codex).findByText('Installing…')).toBeInTheDocument()
    expect(within(rowFor('Codex')).getByText('Installing')).toBeInTheDocument()

    const pi = await open('Pi')
    expect(within(pi).queryByRole('button', { name: 'Install' })).toBeNull()
    await userEvent.click(within(pi).getByRole('button', { name: 'Update' }))
    expect(invokeFn).toHaveBeenCalledWith('providers.install', { kind: 'pi', operation: 'upgrade' })
    expect(await within(pi).findByText('Updating…')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('looks for every provider again on refresh', async () => {
    await renderLoaded()
    expect(screen.getByRole('button', { name: /Checked just now/ })).toBeInTheDocument()

    detections = DETECTIONS.map((d) =>
      d.kind === 'codex' ? { ...CLAUDE, kind: 'codex', version: 'codex-cli 0.160.0' } : d,
    )
    await userEvent.click(screen.getByRole('button', { name: /Checked just now/ }))

    expect(invokeFn).toHaveBeenCalledWith('providers.rescan')
    expect(await within(rowFor('Codex')).findByText('v0.160.0')).toBeInTheDocument()
  })

  it('follows a detection round published after an update', async () => {
    const publish = captureSubscribers()
    await renderLoaded()

    publish({
      type: 'detections',
      detections: DETECTIONS.map((d) =>
        d.kind === 'pi' ? { ...d, version: '1.0.0', updateAvailable: false } : d,
      ),
    })

    expect(await within(rowFor('Pi')).findByText('v1.0.0')).toBeInTheDocument()
    expect(within(rowFor('Pi')).getByText('Ready')).toBeInTheDocument()
  })

  it('runs no sign-in check until one is asked for', async () => {
    await renderLoaded()
    // A preflight spawns a real adapter, so opening Settings must not run one.
    expect(invokeFn).not.toHaveBeenCalledWith('providers.authProbe', expect.anything())
    expect(screen.queryByTestId('provider-signin-claude')).toBeNull()
  })

  it('shows the agent-advertised logins when a turn is refused, and opens the terminal', async () => {
    const publish = captureSubscribers()
    answers['app.info'] = { platform: 'linux', homeDir: '/home/u', cwd: '/w', version: '0.2.0' }
    const onOpenTerminal = vi.fn()
    await renderLoaded({ onOpenTerminal })

    publish({
      type: 'auth.required',
      kind: 'claude',
      label: 'claude (ACP adapter @agentclientprotocol/claude-agent-acp@0.70.0)',
      logins: [
        {
          methodId: 'claude-ai-login',
          name: 'Claude Subscription',
          description: 'Use Claude subscription',
          command: '/usr/bin/node',
          args: ['acp.js', '--cli', 'auth', 'login', '--claudeai'],
        },
      ],
    })

    const prompt = await screen.findByTestId('provider-signin-claude')
    expect(within(prompt).getByRole('alert')).toHaveTextContent(/needs you to sign in again/)
    // The detector called this provider authenticated; the live refusal wins.
    expect(within(rowFor('Claude')).getByText('Sign-in needed')).toBeInTheDocument()

    await userEvent.click(within(prompt).getByRole('button', { name: /Claude Subscription/ }))
    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledOnce())
    expect(invokeFn).toHaveBeenCalledWith('app.info')
  })

  it('explains itself instead of showing a dead button when the agent offers no runnable login', async () => {
    const publish = captureSubscribers()
    await renderLoaded()

    publish({ type: 'auth.required', kind: 'claude', label: 'claude', logins: [] })

    const prompt = await screen.findByTestId('provider-signin-claude')
    expect(within(prompt).getByText(/Run its login once in a terminal/)).toBeInTheDocument()
    expect(within(prompt).queryByRole('button')).toBeNull()
  })

  it('reports the preflight verdict for a provider the user asks about', async () => {
    answers['providers.authProbe'] = { status: 'ready', label: 'claude', version: '2.1.0' }
    await renderLoaded()
    const editor = editorFor('Claude')

    await userEvent.click(within(editor).getByRole('button', { name: /Check sign-in/ }))

    expect(await within(editor).findByText(/this provider is ready/)).toBeInTheDocument()
    expect(invokeFn).toHaveBeenCalledWith('providers.authProbe', { kind: 'claude' })
  })

  it('gives the detector reason for a sign-in it could not verify', async () => {
    await renderLoaded()
    const editor = await open('OpenCode')
    expect(within(editor).getByText(/No opencode auth.json found/)).toBeInTheDocument()
  })

  it('sends Ari Core to the endpoints page instead of offering a path', async () => {
    const onOpenEndpoints = vi.fn()
    await renderLoaded({ onOpenEndpoints })
    const editor = await open('Ari Core')

    expect(within(editor).queryByLabelText('Binary path')).toBeNull()
    await userEvent.click(within(editor).getByRole('button', { name: 'Manage endpoints' }))
    expect(onOpenEndpoints).toHaveBeenCalledOnce()
  })
})
