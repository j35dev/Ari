import { StrictMode, useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { OnboardingAgents, type AgentsView } from './OnboardingAgents'
import { useAgentSetup } from './use-agent-setup'

const { invoke, subscribe, frames } = vi.hoisted(() => {
  const frames = new Set<(payload: unknown) => void>()
  return {
    frames,
    invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
    subscribe: vi.fn((_name: string, _params: unknown, cb: (payload: unknown) => void) => {
      frames.add(cb)
      return () => frames.delete(cb)
    }),
  }
})
vi.mock('../../lib/rpc', () => ({ rpc: { invoke, subscribe } }))
vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: () => <div>Native sign-in terminal</div>,
}))

/** One frame from the shared provider update queue, as the main process publishes it. */
const emit = (frame: unknown) =>
  act(() => {
    for (const cb of [...frames]) cb(frame)
  })

const claudeReady = {
  kind: 'claude',
  installed: true,
  binaryPath: '/bin/claude',
  version: '2.1.0',
  authStatus: 'authenticated',
}
const claudeSignedOut = { ...claudeReady, authStatus: 'unauthenticated' }
const missing = (kind: string) => ({
  kind,
  installed: false,
  binaryPath: null,
  version: null,
  authStatus: 'unknown',
})
let detected: unknown[]
const nativePlan = {
  manager: 'native',
  installCommand: ['powershell.exe', '-Command', "irm 'https://claude.ai/install.ps1' | iex"],
  upgradeCommand: ['claude', 'update'],
  display: 'claude update',
  prerequisite: null,
}

afterEach(cleanup)
beforeEach(() => {
  frames.clear()
  detected = [claudeReady, missing('codex')]
  invoke.mockReset()
  invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.detect' || method === 'providers.rescan') return detected
    if (method === 'providers.plan') return nativePlan
    if (method === 'providers.install') return { started: true }
    if (method === 'providers.cancelInstall') return { cancelled: true }
    if (method === 'providers.setupTerminal') return { ok: true, id: 'setup_1', cwd: '/home/user' }
    if (method === 'providers.authProbe')
      return { status: 'auth-required', label: 'Claude', logins: [] }
    return {}
  })
})

function Harness({ view }: { view: AgentsView }) {
  const setup = useAgentSetup()
  const [selected, setSelected] = useState<DriverKind | null>(null)
  return (
    <OnboardingAgents
      view={view}
      setup={setup}
      selected={selected}
      core={null}
      onSelect={setSelected}
      onUseCore={vi.fn()}
      onBack={vi.fn()}
      onContinue={vi.fn()}
      headingRef={() => undefined}
      primaryRef={() => undefined}
    />
  )
}
const mount = (view: AgentsView = 'list') => render(<Harness view={view} />)

describe('onboarding agents: installed', () => {
  it('lists usable agents with one trailing state, without probes, logins or installs', async () => {
    detected = [
      claudeReady,
      { ...claudeReady, kind: 'grok', binaryPath: '/bin/grok', authStatus: 'unknown' },
      missing('codex'),
    ]
    mount()
    const group = await screen.findByRole('radiogroup', { name: 'Your agent' })
    const claude = (await within(group).findByRole('radio', { name: 'Claude Code' })).parentElement!
    expect(within(claude).getByText('Your Claude account')).toBeInTheDocument()
    expect(within(claude).getByText('Ready')).toBeInTheDocument()
    expect(within(claude).queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Sign in to Grok' })).toBeInTheDocument()
    expect(within(group).queryByRole('radio', { name: 'Codex' })).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('providers.authProbe', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('providers.setupTerminal', expect.anything())
  })

  it('hides an installed agent whose transport is disabled', async () => {
    detected = [
      {
        kind: 'muse',
        installed: true,
        enabled: true,
        authStatus: 'authenticated',
        transport: { mode: 'acp', label: 'Native ACP', available: false },
      },
    ]
    mount()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers.detect'))
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('expands install choices from "Add another agent"', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByRole('radio', { name: 'Claude Code' })
    expect(screen.queryByRole('button', { name: 'Install Codex' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Add another agent/ }))
    expect(await screen.findByRole('button', { name: 'Install Codex' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install OpenCode' })).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
  })

  it('asks the agent before offering a sign-in, then opens it in place and cleans up', async () => {
    detected = [claudeSignedOut]
    const user = userEvent.setup()
    const { unmount } = mount()
    await user.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }))
    expect(invoke).toHaveBeenCalledWith('providers.authProbe', { kind: 'claude' })
    expect(await screen.findByText('Native sign-in terminal')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('providers.setupTerminal', { kind: 'claude' })
    unmount()
    expect(invoke).toHaveBeenCalledWith('terminal.kill', { id: 'setup_1' })
  })

  it('skips the terminal when the agent is already signed in', async () => {
    detected = [claudeSignedOut]
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'providers.authProbe'
        ? Promise.resolve({ status: 'ready', label: 'Claude' })
        : base(method, params),
    )
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }))
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.setupTerminal', expect.anything())
  })

  it('ignores the first StrictMode scan after a newer result has arrived', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    render(
      <StrictMode>
        <Harness view="list" />
      </StrictMode>,
    )
    expect(await screen.findByRole('radio', { name: 'Claude Code' })).toBeInTheDocument()
    await act(async () => {
      resolve([])
    })
    expect(screen.getByRole('radio', { name: 'Claude Code' })).toBeInTheDocument()
  })

  it('keeps detection failures recoverable', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent('could not check for agents')
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('radio', { name: 'Claude Code' })).toBeInTheDocument()
  })
})

describe('onboarding agents: none installed', () => {
  beforeEach(() => {
    detected = [missing('claude'), missing('codex'), missing('opencode')]
  })

  it('recommends Claude Code and Codex, shows the exact command, and installs only on click', async () => {
    const user = userEvent.setup()
    mount('get')
    expect(await screen.findByRole('heading', { name: 'Get a coding agent' })).toBeInTheDocument()
    const cards = screen.getByRole('list', { name: 'Recommended agents' })
    expect(within(cards).getByText('Needs a Claude subscription')).toBeInTheDocument()
    expect(within(cards).getByText('Works with your ChatGPT plan')).toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: 'Other agents' })).getByText('OpenCode'),
    ).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers.plan', { kind: 'claude' }))
    await user.click(within(cards).getAllByRole('button', { name: 'Details' })[0]!)
    expect(screen.getByText(/claude\.ai\/install\.ps1/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
  })

  it('installs through the queue phases, moves straight to sign-in, then reads Ready', async () => {
    const user = userEvent.setup()
    mount('get')
    await user.click(await screen.findByRole('button', { name: 'Install Claude Code' }))
    expect(invoke).toHaveBeenCalledWith('providers.install', {
      kind: 'claude',
      operation: 'install',
    })
    emit({ type: 'install.started', kind: 'claude', operation: 'install' })
    emit({
      type: 'install.phase',
      kind: 'claude',
      phase: 'downloading',
      message: 'Downloading Claude Code',
    })
    const bar = await screen.findByRole('progressbar', { name: 'Installing Claude Code' })
    expect(bar).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByRole('status')).toHaveTextContent('Downloading')
    emit({
      type: 'install.phase',
      kind: 'claude',
      phase: 'verifying',
      message: 'Checking the new version',
    })
    expect(bar).toHaveAttribute('aria-valuenow', '90')
    detected = [claudeSignedOut, missing('codex')]
    emit({
      type: 'install.settled',
      kind: 'claude',
      operation: 'install',
      ok: true,
      reason: null,
      truncated: false,
    })
    expect(await screen.findByText('Native sign-in terminal')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('providers.setupTerminal', { kind: 'claude' })
    detected = [claudeReady, missing('codex')]
    await user.click(screen.getByRole('button', { name: 'I’ve signed in' }))
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(screen.queryByText('Native sign-in terminal')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('providers.rescan')
  })

  it('explains a failed install in place with Retry and the raw output', async () => {
    const user = userEvent.setup()
    mount('get')
    await user.click(await screen.findByRole('button', { name: 'Install Codex' }))
    emit({ type: 'install.started', kind: 'codex', operation: 'install' })
    emit({ type: 'install.progress', kind: 'codex', stream: 'stderr', text: 'npm ERR! EACCES' })
    emit({
      type: 'install.settled',
      kind: 'codex',
      operation: 'install',
      ok: false,
      reason: 'npm could not write to its global folder.',
      details: 'npm ERR! EACCES: permission denied',
      truncated: false,
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('npm could not write to its global folder.')
    const card = alert.closest('li')!
    await user.click(within(card).getByRole('button', { name: 'Details' }))
    expect(screen.getByText('npm ERR! EACCES: permission denied')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('providers.setupTerminal', expect.anything())
    await user.click(within(card).getByRole('button', { name: 'Retry' }))
    expect(invoke.mock.calls.filter(([method]) => method === 'providers.install')).toHaveLength(2)
  })

  it('cancels a running install back to the start, without a failure or a sign-in', async () => {
    const user = userEvent.setup()
    mount('get')
    await user.click(await screen.findByRole('button', { name: 'Install Claude Code' }))
    emit({ type: 'install.started', kind: 'claude', operation: 'install' })
    emit({ type: 'install.phase', kind: 'claude', phase: 'preparing', message: 'Preparing' })
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(invoke).toHaveBeenCalledWith('providers.cancelInstall', { kind: 'claude' })
    emit({
      type: 'install.settled',
      kind: 'claude',
      operation: 'install',
      ok: false,
      reason: 'Cancelled.',
      truncated: false,
    })
    expect(await screen.findByRole('button', { name: 'Install Claude Code' })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('providers.setupTerminal', expect.anything())
  })

  it('explains a missing prerequisite, offers the fix, and never starts the install', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'providers.plan'
        ? Promise.resolve({
            manager: 'npm',
            installCommand: ['npm', 'install', '-g', '@openai/codex'],
            upgradeCommand: ['npm', 'install', '-g', '@openai/codex@latest'],
            display: 'npm install -g @openai/codex@latest',
            prerequisite: {
              program: 'npm',
              label: 'Node.js',
              url: 'https://nodejs.org/en/download',
            },
          })
        : base(method, params),
    )
    const user = userEvent.setup()
    mount('get')
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('Node.js isn’t on this computer yet')
    expect(screen.getAllByRole('button', { name: /^Install / })[0]).toBeDisabled()
    await user.click(screen.getAllByRole('button', { name: 'Get Node.js' })[0]!)
    expect(invoke).toHaveBeenCalledWith('shell.openUrl', { url: 'https://nodejs.org/en/download' })
    expect(invoke).not.toHaveBeenCalledWith('providers.install', expect.anything())
  })

  it('switches an off-by-default agent on before installing it', async () => {
    detected = [missing('claude'), missing('codex'), { ...missing('pi'), enabled: false }]
    const user = userEvent.setup()
    mount('get')
    await user.click(await screen.findByRole('button', { name: 'Install Pi' }))
    expect(invoke).toHaveBeenCalledWith('settings.update', { providers: { pi: { enabled: true } } })
    expect(invoke).toHaveBeenCalledWith('providers.install', { kind: 'pi', operation: 'install' })
  })
})
