import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountRow, RpcResults } from '@ari/contracts/rpc'
import { AccountSwitch } from './AccountSwitch'

const { invokeFn, subscribeFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  subscribeFn: vi.fn<(name: string, params: unknown, cb: (payload: unknown) => void) => () => void>(
    () => () => undefined,
  ),
}))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: invokeFn, subscribe: subscribeFn } }))

type Result = RpcResults['providers.accounts']

const account = (id: string, label: string, active: boolean): ProviderAccountRow => ({
  id,
  label,
  isDefault: id === 'default',
  active,
  identity: { signedIn: true, email: `${id}@example.com`, plan: 'max' },
})

let state: Result

beforeEach(() => {
  state = {
    supported: true,
    accounts: [account('default', 'Default', true), account('work', 'Work', false)],
  }
  subscribeFn.mockReset()
  subscribeFn.mockImplementation(() => () => undefined)
  invokeFn.mockReset()
  invokeFn.mockImplementation((method: string, params: { id?: string }) => {
    if (method === 'providers.accounts.activate') {
      state = {
        supported: true,
        accounts: state.accounts.map((entry) => ({ ...entry, active: entry.id === params.id })),
      }
    }
    return Promise.resolve(state)
  })
})

describe('AccountSwitch', () => {
  it('offers each account with the one in use pressed', async () => {
    render(<AccountSwitch kind="claude" name="Claude" />)

    const group = await screen.findByRole('group', { name: 'Claude account' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('title', 'work@example.com · Max')
    // Only what is already known is asked for: opening the popover starts no CLI.
    expect(invokeFn).toHaveBeenCalledWith('providers.accounts', { kind: 'claude', brief: true })
  })

  it('stays out of the way while a provider has a single account', async () => {
    state = { supported: true, accounts: [account('default', 'Default', true)] }
    const { container } = render(<AccountSwitch kind="claude" name="Claude" />)
    await waitFor(() => expect(invokeFn).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('switches account and tells its host, so usage can be read again', async () => {
    const onSwitched = vi.fn()
    render(<AccountSwitch kind="claude" name="Claude" onSwitched={onSwitched} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Work' }))

    expect(invokeFn).toHaveBeenCalledWith('providers.accounts.activate', { kind: 'claude', id: 'work' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(onSwitched).toHaveBeenCalledOnce()

    // Pressing the account already in use is not a switch.
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(onSwitched).toHaveBeenCalledOnce()
  })

  it('says so when the switch did not happen', async () => {
    const onSwitched = vi.fn()
    render(<AccountSwitch kind="claude" name="Claude" onSwitched={onSwitched} />)
    await screen.findByRole('button', { name: 'Work' })

    invokeFn.mockImplementationOnce(() => Promise.resolve({ ...state, error: 'nope' }))
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Could not switch account.')
    expect(onSwitched).not.toHaveBeenCalled()
  })

  it('follows an account added or switched elsewhere', async () => {
    let publish: (payload: unknown) => void = () => undefined
    subscribeFn.mockImplementation((_name, _params, cb) => {
      publish = cb
      return () => undefined
    })
    state = { supported: true, accounts: [account('default', 'Default', true)] }
    render(<AccountSwitch kind="claude" name="Claude" />)
    await waitFor(() => expect(invokeFn).toHaveBeenCalledTimes(1))

    state = {
      supported: true,
      accounts: [account('default', 'Default', false), account('work', 'Work', true)],
    }
    act(() => publish({ type: 'accounts', kind: 'claude', active: true }))

    expect(await screen.findByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'true')
  })
})
