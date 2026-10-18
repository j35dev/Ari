import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountRow, RpcResults } from '@ari/contracts/rpc'
import { ProviderAccounts } from './ProviderAccounts'
import { accountIdentityLine } from './account-identity-line'

const { invokeFn, subscribeFn, terminalFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  subscribeFn: vi.fn<(name: string, params: unknown, cb: (payload: unknown) => void) => () => void>(
    () => () => undefined,
  ),
  terminalFn: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: invokeFn, subscribe: subscribeFn } }))
vi.mock('../terminal/terminal-requests', () => ({ requestTerminalTab: terminalFn }))

type Result = RpcResults['providers.accounts']

const DEFAULT: ProviderAccountRow = {
  id: 'default',
  label: 'Default',
  isDefault: true,
  active: true,
  identity: { signedIn: true, email: 'me@home.example', plan: 'max' },
}
const WORK: ProviderAccountRow = {
  id: 'work',
  label: 'Work',
  isDefault: false,
  active: false,
  identity: { signedIn: false, email: null, plan: null },
}

/** What the fake main process currently holds; each RPC answers with it. */
let state: Result

function row(label: string): HTMLElement {
  return screen.getByRole('listitem', { name: `${label} account` })
}

beforeEach(() => {
  state = { supported: true, accounts: [DEFAULT] }
  terminalFn.mockReset()
  subscribeFn.mockReset()
  subscribeFn.mockImplementation(() => () => undefined)
  invokeFn.mockReset()
  invokeFn.mockImplementation((method: string, params: { id?: string; label?: string }) => {
    switch (method) {
      case 'providers.accounts':
        return Promise.resolve(state)
      case 'providers.accounts.add':
        state = { supported: true, accounts: [...state.accounts, { ...WORK, label: params.label ?? '' }] }
        return Promise.resolve(state)
      case 'providers.accounts.activate':
        state = {
          supported: true,
          accounts: state.accounts.map((a) => ({ ...a, active: a.id === params.id })),
        }
        return Promise.resolve(state)
      case 'providers.accounts.signOut':
        state = {
          supported: true,
          accounts: state.accounts.map((a) =>
            a.id === params.id ? { ...a, identity: { signedIn: false, email: null, plan: null } } : a,
          ),
        }
        return Promise.resolve(state)
      case 'providers.accounts.remove':
        state = { supported: true, accounts: state.accounts.filter((a) => a.id !== params.id) }
        return Promise.resolve(state)
      case 'providers.accounts.signIn':
        return Promise.resolve({
          title: 'Work sign-in',
          command: '/bin/claude',
          args: ['auth', 'login'],
          env: { CLAUDE_CONFIG_DIR: '/accounts/claude/work' },
        })
      case 'app.info':
        return Promise.resolve({ platform: 'linux', homeDir: '/home/u', cwd: '/w', version: '0.3.5' })
      default:
        return Promise.reject(new Error(`unexpected rpc: ${method}`))
    }
  })
})

describe('ProviderAccounts', () => {
  it('shows the default account as the one in use, with who it is', async () => {
    render(<ProviderAccounts kind="claude" name="Claude" />)

    const account = await screen.findByRole('listitem', { name: 'Default account' })
    expect(within(account).getByText('me@home.example · Max')).toBeInTheDocument()
    expect(within(account).getByText('In use')).toBeInTheDocument()
    // The CLI's own sign-in is not Ari's to delete, and it is already in use.
    expect(within(account).queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(within(account).queryByRole('button', { name: /^Use/ })).toBeNull()
    expect(invokeFn).toHaveBeenCalledWith('providers.accounts', { kind: 'claude', fresh: false })
  })

  it('renders nothing for a provider without accounts', async () => {
    state = { supported: false, accounts: [] }
    const { container } = render(<ProviderAccounts kind="opencode" name="OpenCode" />)
    await waitFor(() => expect(invokeFn).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('adds an account and goes straight to its sign-in in the terminal', async () => {
    const onOpenTerminal = vi.fn()
    render(<ProviderAccounts kind="claude" name="Claude" onOpenTerminal={onOpenTerminal} />)
    await screen.findByRole('listitem', { name: 'Default account' })

    await userEvent.click(screen.getByRole('button', { name: 'Add account' }))
    await userEvent.type(screen.getByLabelText('Account name'), 'Work{Enter}')

    expect(invokeFn).toHaveBeenCalledWith('providers.accounts.add', { kind: 'claude', label: 'Work' })
    await waitFor(() => expect(terminalFn).toHaveBeenCalledOnce())
    expect(terminalFn).toHaveBeenCalledWith({
      title: 'Work sign-in',
      cwd: '/home/u',
      command: "CLAUDE_CONFIG_DIR='/accounts/claude/work' '/bin/claude' 'auth' 'login'",
    })
    expect(onOpenTerminal).toHaveBeenCalledOnce()
    expect(within(row('Work')).getByText('Finish signing in in the Terminal…')).toBeInTheDocument()
    // Adding an account does not switch to it.
    expect(within(row('Default')).getByText('In use')).toBeInTheDocument()
  })

  it('shows a sign-in as finished once the main process announces it', async () => {
    let publish: (payload: unknown) => void = () => undefined
    subscribeFn.mockImplementation((_name, _params, cb) => {
      publish = cb
      return () => undefined
    })
    state = { supported: true, accounts: [DEFAULT, WORK] }
    render(<ProviderAccounts kind="claude" name="Claude" />)
    await screen.findByRole('listitem', { name: 'Work account' })

    await userEvent.click(within(row('Work')).getByRole('button', { name: 'Sign in to Work' }))
    await within(row('Work')).findByText('Finish signing in in the Terminal…')

    state = {
      supported: true,
      accounts: [DEFAULT, { ...WORK, identity: { signedIn: true, email: 'me@work.example', plan: 'pro' } }],
    }
    act(() => publish({ type: 'accounts', kind: 'claude', active: false }))

    expect(await within(row('Work')).findByText('me@work.example · Pro')).toBeInTheDocument()
    // The page itself never asks the CLI: it would be closed by then in the app.
    expect(invokeFn).not.toHaveBeenCalledWith('providers.accounts', { kind: 'claude', fresh: true })
    expect(within(row('Work')).getByRole('button', { name: 'Sign out of Work' })).toBeInTheDocument()
  })

  it('switches the account in use', async () => {
    state = { supported: true, accounts: [DEFAULT, WORK] }
    render(<ProviderAccounts kind="claude" name="Claude" />)
    await screen.findByRole('listitem', { name: 'Work account' })

    await userEvent.click(within(row('Work')).getByRole('button', { name: 'Use Work' }))

    expect(invokeFn).toHaveBeenCalledWith('providers.accounts.activate', { kind: 'claude', id: 'work' })
    expect(await within(row('Work')).findByText('In use')).toBeInTheDocument()
    expect(within(row('Default')).queryByText('In use')).toBeNull()
    expect(within(row('Default')).getByRole('button', { name: 'Use Default' })).toBeInTheDocument()
  })

  it('asks before removing an account, since that deletes its sign-in', async () => {
    state = { supported: true, accounts: [DEFAULT, WORK] }
    render(<ProviderAccounts kind="claude" name="Claude" />)
    await screen.findByRole('listitem', { name: 'Work account' })

    await userEvent.click(within(row('Work')).getByRole('button', { name: 'Remove Work' }))
    expect(invokeFn).not.toHaveBeenCalledWith('providers.accounts.remove', expect.anything())
    expect(within(row('Work')).getByText('Delete this sign-in?')).toBeInTheDocument()

    await userEvent.click(within(row('Work')).getByRole('button', { name: 'Remove' }))
    expect(invokeFn).toHaveBeenCalledWith('providers.accounts.remove', { kind: 'claude', id: 'work' })
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Work account' })).toBeNull())
  })

  it('signs an account out through the CLI', async () => {
    render(<ProviderAccounts kind="claude" name="Claude" />)
    const account = await screen.findByRole('listitem', { name: 'Default account' })

    await userEvent.click(within(account).getByRole('button', { name: 'Sign out of Default' }))

    expect(invokeFn).toHaveBeenCalledWith('providers.accounts.signOut', { kind: 'claude', id: 'default' })
    expect(await within(row('Default')).findByText('Not signed in')).toBeInTheDocument()
    expect(within(row('Default')).getByRole('button', { name: 'Sign in to Default' })).toBeInTheDocument()
  })

  it('says why a change did not happen and keeps the list as it is', async () => {
    state = { supported: true, accounts: [DEFAULT, WORK] }
    render(<ProviderAccounts kind="claude" name="Claude" />)
    await screen.findByRole('listitem', { name: 'Work account' })

    invokeFn.mockImplementationOnce(() =>
      Promise.resolve({ ...state, error: 'Could not switch to that account.' }),
    )
    await userEvent.click(within(row('Work')).getByRole('button', { name: 'Use Work' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch to that account.')
    expect(within(row('Default')).getByText('In use')).toBeInTheDocument()
  })

  it('follows a change made elsewhere', async () => {
    let publish: (payload: unknown) => void = () => undefined
    subscribeFn.mockImplementation((_name, _params, cb) => {
      publish = cb
      return () => undefined
    })
    render(<ProviderAccounts kind="claude" name="Claude" />)
    await screen.findByRole('listitem', { name: 'Default account' })

    state = { supported: true, accounts: [{ ...DEFAULT, active: false }, { ...WORK, active: true }] }
    act(() => publish({ type: 'accounts', kind: 'codex', active: true }))
    act(() => publish({ type: 'accounts', kind: 'claude', active: true }))

    expect(await within(await screen.findByRole('listitem', { name: 'Work account' })).findByText('In use')).toBeInTheDocument()
    expect(invokeFn.mock.calls.filter(([method]) => method === 'providers.accounts')).toHaveLength(2)
  })
})

describe('accountIdentityLine', () => {
  it('tells signed in, signed out, signing in and unknown apart', () => {
    expect(accountIdentityLine(DEFAULT, false)).toBe('me@home.example · Max')
    expect(
      accountIdentityLine({ ...DEFAULT, identity: { signedIn: true, email: null, plan: null } }, false),
    ).toBe('Signed in')
    expect(accountIdentityLine(WORK, false)).toBe('Not signed in')
    expect(accountIdentityLine(WORK, true)).toBe('Finish signing in in the Terminal…')
    expect(accountIdentityLine({ ...WORK, identity: null }, false)).toBe('Could not check the sign-in')
  })
})
