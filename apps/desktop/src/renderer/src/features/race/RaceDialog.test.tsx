import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RaceDialog } from './RaceDialog'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const PROJECTS = [
  { id: 'proj_1', name: 'Ari' },
  { id: 'proj_2', name: 'Website' },
]

/** Finds the Select trigger button showing the given selected label. */
function triggerFor(label: string): HTMLElement {
  const triggers = screen
    .getAllByRole('button')
    .filter((b) => b.querySelector('span')?.textContent === label)
  if (triggers.length === 0) throw new Error(`no select trigger for ${label}`)
  return triggers[0] as HTMLElement
}

describe('RaceDialog', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
  })

  it('defaults to two installed CLIs and never offers uninstalled ones', async () => {
    installDetect(['claude', 'codex'])
    render(<RaceDialog projects={PROJECTS} onLaunched={() => undefined} onClose={() => undefined} />)

    await waitFor(() => expect(triggerFor('Claude')).toBeInTheDocument())
    expect(triggerFor('Codex')).toBeInTheDocument()
    // Grok is not installed — opening a picker must not offer it.
    const user = userEvent.setup()
    await user.click(triggerFor('Claude'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByText('Grok')).not.toBeInTheDocument()
    expect(within(listbox).getByText('Ari Core')).toBeInTheDocument()
  })

  it('refuses same-provider races with an inline error', async () => {
    installDetect(['claude', 'codex'])
    const user = userEvent.setup()
    render(<RaceDialog projects={PROJECTS} onLaunched={() => undefined} onClose={() => undefined} />)
    await waitFor(() => expect(triggerFor('Claude')).toBeInTheDocument())

    // Flip provider B onto Claude via its picker.
    await user.click(triggerFor('Codex'))
    await user.click(await screen.findByRole('option', { name: 'Claude' }))

    await user.type(screen.getByLabelText(/prompt/i), 'do a thing')
    await user.click(screen.getByRole('button', { name: 'Start race' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/two different providers/)
    expect(rpcMocks.invoke).not.toHaveBeenCalledWith(
      'session.create',
      expect.anything(),
    )
  })

  it('creates both sessions and starts both turns on launch', async () => {
    installDetect(['claude', 'codex'])
    const ids = ['sess_aaa', 'sess_bbb']
    let createCalls = 0
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') {
        return ['claude', 'codex'].map((kind) => ({
          kind,
          installed: true,
          binaryPath: `${kind}-bin`,
          version: '1.0.0',
          authStatus: 'authenticated',
        }))
      }
      if (method === 'session.create') return { sessionId: ids[createCalls++] ?? 'sess_x' }
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected ${String(method)}`)
    })
    const onLaunched = vi.fn()
    const user = userEvent.setup()
    render(<RaceDialog projects={PROJECTS} onLaunched={onLaunched} onClose={() => undefined} />)

    await waitFor(() => expect(triggerFor('Claude')).toBeInTheDocument())
    await user.type(screen.getByLabelText(/prompt/i), 'add rate limiting')
    await user.click(screen.getByRole('button', { name: 'Start race' }))

    await waitFor(() => {
      expect(onLaunched).toHaveBeenCalledWith('sess_aaa', 'sess_bbb')
    })
    const creates = rpcMocks.invoke.mock.calls.filter(([m]) => m === 'session.create')
    expect(creates).toHaveLength(2)
    const titles = creates.map(
      ([, params]) => (params as { title: string }).title,
    )
    expect(titles).toEqual(['Race A · Claude', 'Race B · Codex'])
    const turns = rpcMocks.invoke.mock.calls.filter(
      ([m]) => m === 'command.dispatch',
    ) as unknown as [string, { command: { type: string; text?: string; sessionId?: string } }][]
    expect(turns.map(([, p]) => p.command.type)).toEqual(['turn.start', 'turn.start'])
    for (const [, p] of turns) {
      expect(p.command.text).toBe('add rate limiting')
      expect(p.command.sessionId).toBeDefined()
    }
  })
})

function installDetect(installed: string[]): void {
  rpcMocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.detect') {
      return installed.map((kind) => ({
        kind,
        installed: true,
        binaryPath: `${kind}-bin`,
        version: '1.0.0',
        authStatus: 'authenticated',
      }))
    }
    if (method === 'session.create') return { sessionId: `sess_${Math.random().toString(36).slice(2, 8)}` }
    if (method === 'command.dispatch') return { accepted: true }
    throw new Error(`unexpected method: ${String(method)}`)
  })
}
