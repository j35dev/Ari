// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { useApp, type AppValue } from '../../lib/app-state'
import { ForkSheet } from './ForkSheet'
import { ForkRequestStore } from './fork-request'
import { SessionDetails } from './SessionDetails'

vi.mock('../../lib/app-state', () => ({ useApp: vi.fn() }))
const parent: Session = {
  id: 'sess_parent',
  projectId: 'proj_mobile',
  title: 'Polish mobile',
  driverKind: 'claude',
  modelId: 'claude-sonnet-4-6',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}

function setup(overrides: Partial<AppValue> = {}) {
  const send = vi
    .fn<(command: Record<string, unknown>, key: string) => Promise<unknown>>()
    .mockResolvedValue({ ok: true, result: { sessionId: 'sess_child' } })
  const supports = vi.fn(() => true)
  const refresh = vi.fn().mockResolvedValue(undefined)
  const value = {
    origin: 'https://ari.example.com',
    connection: 'connected',
    session: { deviceId: 'device_test', supports, send },
    catalog: {
      providers: [
        { driverKind: 'claude', models: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet' }] },
        { driverKind: 'codex', models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }] },
      ],
    },
    refresh,
    ...overrides,
  } as unknown as AppValue
  vi.mocked(useApp).mockReturnValue(value)
  const onClose = vi.fn()
  const onForked = vi.fn()
  return {
    send,
    supports,
    refresh,
    value,
    onClose,
    onForked,
    user: userEvent.setup(),
    props: { parent, onClose, onForked },
  }
}

beforeEach(() => {
  sessionStorage.clear()
  history.replaceState(null, '', '/?computer=computer_test')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ForkSheet', () => {
  it('defaults to the parent provider and model, sending only fork fields', async () => {
    const test = setup()
    render(<ForkSheet {...test.props} />)
    await test.user.clear(screen.getByRole<HTMLInputElement>('textbox', { name: 'Fork name' }))
    await test.user.type(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Fork name' }),
      '  Accessible mobile  ',
    )
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.send).toHaveBeenCalledWith(
      {
        op: 'session.fork',
        sessionId: parent.id,
        title: 'Accessible mobile',
        driverKind: 'claude',
        modelId: parent.modelId,
      },
      expect.any(String),
    )
    expect(test.refresh).toHaveBeenCalledOnce()
    expect(test.onForked).toHaveBeenCalledWith('sess_child')
    expect(new ForkRequestStore(test.value.origin, 'device_test', parent.id).read()).toBeNull()
  })

  it('uses the changed provider default until a model is explicitly selected', async () => {
    const test = setup()
    render(<ForkSheet {...test.props} />)
    await test.user.selectOptions(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Agent' }),
      'codex',
    )
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).value).toBe('')
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.send.mock.calls[0]?.[0]).toEqual({
      op: 'session.fork',
      sessionId: parent.id,
      title: 'Fork: Polish mobile',
      driverKind: 'codex',
    })
  })

  it('can choose a model for the changed provider', async () => {
    const test = setup()
    render(<ForkSheet {...test.props} />)
    await test.user.selectOptions(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Agent' }),
      'codex',
    )
    await test.user.selectOptions(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }),
      'gpt-5.4',
    )
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.send.mock.calls[0]?.[0]).toMatchObject({ driverKind: 'codex', modelId: 'gpt-5.4' })
  })

  it('requires a nonblank title and bounds it to 120 characters', async () => {
    const test = setup()
    render(<ForkSheet {...test.props} />)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Fork name' })
    expect(input.maxLength).toBe(120)
    await test.user.clear(input)
    await test.user.type(input, '   ')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }).disabled).toBe(
      true,
    )
    expect(test.send).not.toHaveBeenCalled()
  })

  it('keeps controls locked during native approval and links to the list of what needs the user', async () => {
    const test = setup()
    test.send.mockImplementation(() => new Promise(() => {}))
    render(<ForkSheet {...test.props} />)
    await test.user.dblClick(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.send).toHaveBeenCalledOnce()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Fork name' }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('five minutes')
    expect(screen.getByRole('link', { name: 'See what needs you' }).getAttribute('href')).toBe(
      '/?computer=computer_test',
    )
  })

  it('restores an uncertain request and retries the exact same key after leaving the sheet', async () => {
    const test = setup()
    test.send.mockRejectedValueOnce(new Error('Response unavailable'))
    const first = render(<ForkSheet {...test.props} />)
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    await screen.findByRole('alert')
    const [command, key] = test.send.mock.calls[0]!
    first.unmount()
    render(<ForkSheet {...test.props} />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Fork name' }).disabled).toBe(true)
    await test.user.click(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retry same fork' }),
    )
    expect(test.send).toHaveBeenLastCalledWith(command, key)
    expect(test.onForked).toHaveBeenCalledWith('sess_child')
  })

  it('retains the receipt if a successful request completes after leaving the sheet', async () => {
    const test = setup()
    let resolve: (value: unknown) => void = () => {}
    test.send.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const view = render(<ForkSheet {...test.props} />)
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    view.unmount()
    await act(async () => {
      resolve({ ok: true, result: { sessionId: 'sess_child' } })
    })
    expect(test.onForked).not.toHaveBeenCalled()
    expect(new ForkRequestStore(test.value.origin, 'device_test', parent.id).read()).not.toBeNull()
  })

  it('does not mint a replacement key when the child identifier is missing', async () => {
    const test = setup()
    test.send.mockResolvedValueOnce({ ok: true, result: {} })
    render(<ForkSheet {...test.props} />)
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect((await screen.findByRole('alert')).textContent).toContain('did not confirm')
    await test.user.click(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Retry same fork' }),
    )
    expect(test.send.mock.calls[1]?.[1]).toEqual(test.send.mock.calls[0]?.[1])
  })

  it('refuses network creation when a durable receipt cannot be saved', async () => {
    const test = setup()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled')
    })
    render(<ForkSheet {...test.props} />)
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not save the fork receipt',
    )
    expect(test.send).not.toHaveBeenCalled()
  })

  it('navigates to a confirmed child even if workspace refresh fails', async () => {
    const test = setup()
    test.refresh.mockRejectedValueOnce(new Error('Refresh failed'))
    render(<ForkSheet {...test.props} />)
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    await waitFor(() => expect(test.onForked).toHaveBeenCalledWith('sess_child'))
    expect(test.send).toHaveBeenCalledOnce()
  })

  it('can retain the parent model when no catalog is available', async () => {
    const test = setup({ catalog: null })
    render(<ForkSheet {...test.props} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).value).toBe(
      parent.modelId,
    )
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.send.mock.calls[0]?.[0]).toMatchObject({
      driverKind: parent.driverKind,
      modelId: parent.modelId,
    })
  })

  it.each(['unreachable', 'revoked'] as const)('disables fork creation while %s', (connection) => {
    const test = setup({ connection })
    render(<ForkSheet {...test.props} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }).disabled).toBe(
      true,
    )
  })
})

describe('SessionDetails fork entry', () => {
  it('opens the fork sheet and carries the child navigation callback', async () => {
    const test = setup()
    render(
      <SessionDetails
        session={parent}
        onClose={test.onClose}
        onChanged={test.refresh}
        onForked={test.onForked}
      />,
    )
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Fork session' }))
    await test.user.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Create fork' }))
    expect(test.onForked).toHaveBeenCalledWith('sess_child')
  })

  it('hides an unsupported fork operation', () => {
    const test = setup()
    test.supports.mockImplementation(() => false)
    render(
      <SessionDetails
        session={parent}
        onClose={test.onClose}
        onChanged={test.refresh}
        onForked={test.onForked}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Fork session' })).toBeNull()
  })

  it('requires a navigation callback to expose a fork', () => {
    const test = setup()
    render(<SessionDetails session={parent} onClose={test.onClose} onChanged={test.refresh} />)
    expect(screen.queryByRole('button', { name: 'Fork session' })).toBeNull()
  })

  it('disables the fork entry while disconnected', () => {
    const test = setup({ connection: 'unreachable' })
    render(
      <SessionDetails
        session={parent}
        onClose={test.onClose}
        onChanged={test.refresh}
        onForked={test.onForked}
      />,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fork session' }).disabled).toBe(
      true,
    )
  })
})
