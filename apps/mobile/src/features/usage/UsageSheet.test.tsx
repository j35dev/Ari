// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAllowance } from '@ari/contracts/remote'
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
  session: { query: vi.fn<(op: string, params: { driverKind: string }) => Promise<unknown>>() },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

const HOUR = 3_600_000
function allowance(
  fields: Partial<RemoteAllowance> & Pick<RemoteAllowance, 'driverKind'>,
): RemoteAllowance {
  return { status: 'available', windows: [], bankedResets: 0, updatedAt: Date.now(), ...fields }
}
let answers: Record<string, RemoteAllowance | Error>

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
  app.session.query.mockImplementation(async (_op, { driverKind }) => {
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
