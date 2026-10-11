// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAccounts, RemoteAllowance } from '@ari/contracts/remote'
import { UsageSheet } from './UsageSheet'

const app = vi.hoisted(() => ({
  catalog: {
    providers: [
      { driverKind: 'claude', installed: true, models: [] },
      { driverKind: 'codex', installed: true, models: [] },
      { driverKind: 'opencode', installed: true, models: [] },
      { driverKind: 'grok', installed: false, models: [] },
      { driverKind: 'ari-core', installed: true, models: [] },
    ],
  },
  session: {
    query: vi.fn<(op: string, params: { driverKind: string }) => Promise<unknown>>(),
    supports: vi.fn<(op: string) => boolean>(),
    send: vi.fn<(command: { op: string; driverKind: string; accountId?: string }) => Promise<unknown>>(),
  },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

const HOUR = 3_600_000
function allowance(
  fields: Partial<RemoteAllowance> & Pick<RemoteAllowance, 'driverKind'>,
): RemoteAllowance {
  return { status: 'available', windows: [], bankedResets: 0, updatedAt: Date.now(), ...fields }
}
let answers: Record<string, RemoteAllowance | Error>
/** What the desktop lists as each provider's accounts; none unless a test says so. */
let accounts: Record<string, RemoteAccounts['accounts']>

beforeEach(() => {
  answers = {
    claude: allowance({
      driverKind: 'claude',
      windows: [
        { label: '5h', usedPercent: 92.4, resetsAt: Date.now() + 2 * HOUR },
        { label: 'Weekly', usedPercent: 31, resetsAt: null, resetText: 'Friday' },
      ],
      bankedResets: 2,
    }),
    codex: allowance({
      driverKind: 'codex',
      windows: [{ label: '5h', usedPercent: 8, resetsAt: Date.now() + HOUR }],
    }),
    opencode: allowance({ driverKind: 'opencode', status: 'unavailable', updatedAt: null }),
  }
  accounts = {}
  // A desktop from before accounts and phone-side resets, unless a test upgrades it.
  app.session.supports.mockReturnValue(false)
  app.session.query.mockImplementation(async (op, { driverKind }) => {
    if (op === 'accounts.list') return { driverKind, accounts: accounts[driverKind] ?? [] }
    const answer = answers[driverKind]
    if (answer instanceof Error) throw answer
    return answer
  })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('usage sheet', () => {
  it('asks only about installed account providers and shows each window', async () => {
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })

    expect(app.session.query.mock.calls.map(([op, params]) => [op, params.driverKind])).toEqual([
      ['usage.allowance', 'claude'],
      ['usage.allowance', 'codex'],
      ['usage.allowance', 'opencode'],
    ])
    const fiveHour = within(claude).getByRole('progressbar', { name: 'Claude Code 5h used' })
    expect(fiveHour.getAttribute('aria-valuenow')).toBe('92')
    expect(within(claude).getByText('92% used')).toBeTruthy()
    expect(within(claude).getByText('Resets in 2h')).toBeTruthy()
    expect(within(claude).getByText('Resets Friday')).toBeTruthy()
    expect(within(claude).getByText(/2 resets banked/)).toBeTruthy()
    expect(within(claude).queryByRole('button')).toBeNull()
    expect(screen.getByText('No usage reported by OpenCode.')).toBeTruthy()
  })

  it('puts the open session provider first', async () => {
    render(<UsageSheet current="codex" onClose={() => {}} />)
    await screen.findByRole('region', { name: 'Claude Code usage' })
    const regions = screen.getAllByRole('region')
    expect(regions[0]?.getAttribute('aria-label')).toBe('Codex usage')
    expect(within(regions[0] as HTMLElement).getByText('This session')).toBeTruthy()
  })

  it('keeps the last numbers and calls them stale when a refresh fails', async () => {
    render(<UsageSheet onClose={() => {}} />)
    const codex = await screen.findByRole('region', { name: 'Codex usage' })
    expect(within(codex).queryByText(/Stale/)).toBeNull()

    answers['codex'] = new Error('the desktop did not answer')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))

    await waitFor(() => expect(within(codex).getByText(/Stale/)).toBeTruthy())
    expect(within(codex).getByText('8% used')).toBeTruthy()
  })

  it('says which provider could not be read at all', async () => {
    answers['codex'] = new Error('the desktop did not answer')
    render(<UsageSheet onClose={() => {}} />)
    expect((await screen.findByText(/Could not read Codex/)).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('region', { name: 'Codex usage' })).toBeNull()
  })
})

describe('usage sheet on a desktop that offers accounts and resets', () => {
  const account = (id: string, label: string, active: boolean, signedIn = true) => ({
    id,
    label,
    active,
    signedIn,
    plan: 'max',
  })

  beforeEach(() => {
    app.session.supports.mockImplementation(
      (op) => op === 'accounts.list' || op === 'usage.redeem',
    )
    accounts['claude'] = [account('default', 'Default', true), account('work', 'Work', false)]
    accounts['codex'] = [account('default', 'Default', true)]
  })

  it('offers a provider’s accounts only where there is a choice', async () => {
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    const group = await within(claude).findByRole('group', { name: 'Claude Code account' })

    expect(within(group).getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(group).getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('false')
    const codex = screen.getByRole('region', { name: 'Codex usage' })
    expect(within(codex).queryByRole('group')).toBeNull()
  })

  it('switches the account on the computer and reads that account’s usage', async () => {
    app.session.send.mockImplementation(async ({ accountId }) => {
      accounts['claude'] = [
        account('default', 'Default', accountId === 'default'),
        account('work', 'Work', accountId === 'work'),
      ]
      answers['claude'] = allowance({
        driverKind: 'claude',
        windows: [{ label: '5h', usedPercent: 3, resetsAt: Date.now() + HOUR }],
      })
      return { driverKind: 'claude', accounts: accounts['claude'] }
    })
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    fireEvent.click(await within(claude).findByRole('button', { name: 'Work' }))

    expect(app.session.send).toHaveBeenCalledWith({
      op: 'accounts.activate',
      driverKind: 'claude',
      accountId: 'work',
    })
    const after = await screen.findByRole('region', { name: 'Claude Code usage' })
    await waitFor(() => expect(within(after).getByText('3% used')).toBeTruthy())
    expect(within(after).queryByText('92% used')).toBeNull()
    expect(within(after).getByRole('button', { name: 'Work' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps a provider on screen whose account in use has nothing to report', async () => {
    answers['claude'] = allowance({ driverKind: 'claude', status: 'unavailable', updatedAt: null })
    accounts['claude'] = [account('default', 'Default', false), account('work', 'Work', true, false)]
    render(<UsageSheet onClose={() => {}} />)

    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    expect(await within(claude).findByText(/Work is not signed in/)).toBeTruthy()
    expect(within(claude).getByText('No usage reported for this account.')).toBeTruthy()
    // Still the place to go back to the account that works.
    expect(within(claude).getByRole('button', { name: 'Default' })).toBeTruthy()
  })

  it('says why a switch did not happen', async () => {
    app.session.send.mockRejectedValue(new Error('That account no longer exists.'))
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    fireEvent.click(await within(claude).findByRole('button', { name: 'Work' }))

    expect(await within(claude).findByText('That account no longer exists.')).toBeTruthy()
    expect(within(claude).getByText('92% used')).toBeTruthy()
  })

  it('spends a banked reset only after a second, explicit tap', async () => {
    app.session.send.mockResolvedValue({
      outcome: 'reset',
      allowance: allowance({
        driverKind: 'claude',
        windows: [{ label: '5h', usedPercent: 0, resetsAt: Date.now() + 5 * HOUR }],
        bankedResets: 1,
      }),
    })
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })

    fireEvent.click(within(claude).getByRole('button', { name: 'Use a Claude Code reset' }))
    expect(within(claude).getByText(/Use one of your 2 banked resets now\?/)).toBeTruthy()
    expect(app.session.send).not.toHaveBeenCalled()

    fireEvent.click(within(claude).getByRole('button', { name: 'Cancel' }))
    expect(app.session.send).not.toHaveBeenCalled()

    fireEvent.click(within(claude).getByRole('button', { name: 'Use a Claude Code reset' }))
    fireEvent.click(within(claude).getByRole('button', { name: 'Use reset' }))

    expect(app.session.send).toHaveBeenCalledWith({ op: 'usage.redeem', driverKind: 'claude' })
    expect(await within(claude).findByText('Reset applied.')).toBeTruthy()
    expect(within(claude).getByText('0% used')).toBeTruthy()
    expect(within(claude).getByText('1 reset banked')).toBeTruthy()
    expect(app.session.send).toHaveBeenCalledTimes(1)
  })

  it('reports a reset the provider did not apply, and keeps the count it sent back', async () => {
    app.session.send.mockResolvedValue({
      outcome: 'nothingToReset',
      allowance: answers['claude'],
    })
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    fireEvent.click(within(claude).getByRole('button', { name: 'Use a Claude Code reset' }))
    fireEvent.click(within(claude).getByRole('button', { name: 'Use reset' }))

    expect(await within(claude).findByText(/Nothing to reset/)).toBeTruthy()
    expect(within(claude).getByText('2 resets banked')).toBeTruthy()
  })

  it('shows the desktop’s reason when a reset could not be used', async () => {
    app.session.send.mockRejectedValue(new Error('Sign in to Claude again on your computer.'))
    render(<UsageSheet onClose={() => {}} />)
    const claude = await screen.findByRole('region', { name: 'Claude Code usage' })
    fireEvent.click(within(claude).getByRole('button', { name: 'Use a Claude Code reset' }))
    fireEvent.click(within(claude).getByRole('button', { name: 'Use reset' }))

    expect(await within(claude).findByText('Sign in to Claude again on your computer.')).toBeTruthy()
  })
})
