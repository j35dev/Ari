import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { ModelSelector } from './ModelSelector'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

function setup(
  driverKind: DriverKind = 'claude',
  modelId: string | null = 'sonnet-4',
  lockedTo: DriverKind | null = null,
): {
  onChange: ReturnType<typeof vi.fn>
} {
  const onChange = vi.fn()
  render(
    <ModelSelector driverKind={driverKind} modelId={modelId} onChange={onChange} lockedTo={lockedTo} />,
  )
  return { onChange }
}

describe('ModelSelector', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      switch (method) {
        case 'providers.detect':
          return [
            {
              kind: 'claude',
              installed: true,
              binaryPath: 'c',
              version: '1',
              authStatus: 'authenticated',
            },
            {
              kind: 'codex',
              installed: true,
              binaryPath: 'x',
              version: '1',
              authStatus: 'authenticated',
            },
          ]
        case 'providers.models':
          return [
            {
              kind: 'claude',
              source: 'live',
              models: [
                { id: 'sonnet-4', label: 'Sonnet 4.5', contextHint: '200k' },
                { id: 'opus-4', label: 'Opus 4' },
              ],
            },
            {
              kind: 'codex',
              source: 'live',
              models: [{ id: 'gpt-5.6', label: 'GPT-5.6' }],
            },
          ]
        case 'endpoints.list':
          return []
        default:
          throw new Error(`unexpected ${String(method)}`)
      }
    })
  })

  it('trigger shows a letter mark plus the model label', async () => {
    setup()
    const trigger = await screen.findByRole('button', { name: /model:/i })
    await waitFor(() => {
      expect(trigger).toHaveTextContent('C')
      expect(trigger).toHaveTextContent('Sonnet 4.5')
    })
  })

  it('opens on the provider list, drills in, and selects with keyboard', async () => {
    const { onChange } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    // Step one: providers only, never a mixed model dump.
    const providers = screen.getByRole('listbox', { name: 'Providers' })
    expect(within(providers).getByText('Claude')).toBeInTheDocument()
    expect(within(providers).getByText('Codex')).toBeInTheDocument()

    // The current provider is marked and shows its active model in its row.
    expect(within(providers).getByRole('option', { selected: true })).toHaveTextContent('Claude')
    expect(within(providers).getByText('Sonnet 4.5')).toBeInTheDocument()
    // …but no models are selectable at this step — only providers are options.
    expect(within(providers).queryByRole('option', { name: 'Sonnet 4.5' })).not.toBeInTheDocument()

    // Enter drills into the highlighted provider (Claude is first).
    await user.keyboard('{Enter}')
    const models = screen.getByRole('listbox', { name: 'Models' })
    expect(within(models).getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(within(models).getByText('Opus 4')).toBeInTheDocument()
    expect(within(models).queryByText('GPT-5.6')).not.toBeInTheDocument()

    // Search filters within the provider.
    await user.type(screen.getByLabelText('Search models'), 'opus')
    expect(within(models).getByText('Opus 4')).toBeInTheDocument()
    expect(within(models).queryByText('Sonnet 4.5')).not.toBeInTheDocument()

    await user.keyboard('{Home}{Enter}')
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
    })
  })

  it('marks the active model and picks on click, across providers', async () => {
    const { onChange } = setup('codex', 'gpt-5.6')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    const providers = screen.getByRole('listbox', { name: 'Providers' })
    expect(within(providers).getByRole('option', { selected: true })).toHaveTextContent('Codex')

    await user.click(within(providers).getByText('Claude'))
    const models = screen.getByRole('listbox', { name: 'Models' })
    await user.click(within(models).getByText('Sonnet 4.5'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
  })

  it('goes back with the header button and Esc', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    await user.click(within(screen.getByRole('listbox', { name: 'Providers' })).getByText('Codex'))
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.getByRole('listbox', { name: 'Providers' })).toBeInTheDocument()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    // Esc on step two goes back to providers, not straight out of the menu.
    expect(screen.getByRole('listbox', { name: 'Providers' })).toBeInTheDocument()
  })

  it('maps an endpoint pick to the ari-core driver with its ep: handle', async () => {
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') {
        return [
          {
            kind: 'ari-core',
            installed: true,
            binaryPath: null,
            version: '1',
            authStatus: 'authenticated',
          },
        ]
      }
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') {
        return [{ id: 'end_1', name: 'My Relay', model: 'relay-large' }]
      }
      throw new Error(`unexpected ${String(method)}`)
    })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ModelSelector driverKind='ari-core' modelId={null} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /model:/i }))
    const providers = screen.getByRole('listbox', { name: 'Providers' })
    await user.click(within(providers).getByText('Ari Core'))

    const models = screen.getByRole('listbox', { name: 'Models' })
    await user.click(within(models).getByText('My Relay'))

    // The old behaviour sent driverKind 'ep' (splitting 'ep:end_1'), which
    // failed session.create validation the moment a custom endpoint existed.
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'ari-core', modelId: 'ep:end_1' })
  })

  it('shows the endpoint name, not its raw ep: handle, on the trigger', async () => {
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') {
        return [{ id: 'end_1', name: 'My Relay', model: 'relay-large' }]
      }
      throw new Error(`unexpected ${String(method)}`)
    })
    render(<ModelSelector driverKind='ari-core' modelId='ep:end_1' onChange={vi.fn()} />)

    const trigger = await screen.findByRole('button', { name: /model:/i })
    expect(trigger).toHaveTextContent('My Relay')
    expect(trigger).not.toHaveTextContent('ep:end_1')
  })

  it('shows a loading empty state before catalogs resolve', async () => {
    rpcMocks.invoke.mockImplementation(() => new Promise(() => undefined))
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /model:/i }))
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows a no-match state for nonsense queries inside a provider', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.click(within(screen.getByRole('listbox', { name: 'Providers' })).getByText('Claude'))
    await user.type(screen.getByLabelText('Search models'), 'zzz')
    expect(screen.getByText(/no models match/i)).toBeInTheDocument()
  })

  it('lockedTo skips the provider step and explains the lock', async () => {
    const { onChange } = setup('claude', 'sonnet-4', 'claude')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    // Straight to the session provider's models; no provider list, no back.
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(within(listbox).getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Providers' })).not.toBeInTheDocument()
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(screen.getByText(/start a new session to use another agent/i)).toBeInTheDocument()

    // Picking the still-offered model keeps working and stays on the driver.
    await user.click(within(listbox).getByText('Opus 4'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
  })
})
