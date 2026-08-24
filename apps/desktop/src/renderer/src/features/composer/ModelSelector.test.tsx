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

function setup(driverKind: DriverKind = 'claude', modelId: string | null = 'sonnet-4'): {
  onChange: ReturnType<typeof vi.fn>
} {
  const onChange = vi.fn()
  render(<ModelSelector driverKind={driverKind} modelId={modelId} onChange={onChange} />)
  return { onChange }
}

describe('ModelSelector', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      switch (method) {
        case 'providers.detect':
          return [
            { kind: 'claude', binaryPath: 'c', version: '1', authStatus: 'authenticated' },
            { kind: 'codex', binaryPath: 'x', version: '1', authStatus: 'authenticated' },
          ]
        case 'providers.models':
          return [
            {
              kind: 'claude',
              source: 'static',
              models: [
                { id: 'sonnet-4', label: 'Sonnet 4.5' },
                { id: 'opus-4', label: 'Opus 4' },
              ],
            },
            {
              kind: 'codex',
              source: 'static',
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

  it('pill shows a provider chip plus the model label', async () => {
    setup()
    const pill = await screen.findByRole('button', { name: 'Model selector' })
    await waitFor(() => {
      expect(pill).toHaveTextContent('claude')
    })
    expect(pill).toHaveTextContent('Sonnet 4.5')
  })

  it('opens a grouped, searchable menu and selects with keyboard', async () => {
    const { onChange } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Model selector' }))

    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(within(listbox).getByText('claude')).toBeInTheDocument()
    expect(within(listbox).getByText('codex')).toBeInTheDocument()

    // Search filters across label and provider.
    await user.type(screen.getByLabelText('Search models'), 'gpt')
    expect(within(listbox).getByText('GPT-5.6')).toBeInTheDocument()
    expect(within(listbox).queryByText('Sonnet 4.5')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('Search models'))
    await user.keyboard('{ArrowUp>}{ArrowUp}{/ArrowUp}')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
    })
  })

  it('marks the active model and picks on click', async () => {
    const { onChange } = setup('codex', 'gpt-5.6')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Model selector' }))

    const listbox = screen.getByRole('listbox', { name: 'Models' })
    const active = within(listbox).getByRole('option', { selected: true })
    expect(active).toHaveTextContent('GPT-5.6')

    await user.click(within(listbox).getByText('Sonnet 4.5'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
  })

  it('shows a no-match state for nonsense queries', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Model selector' }))
    await user.type(screen.getByLabelText('Search models'), 'zzz')
    expect(screen.getByText(/no models match/i)).toBeInTheDocument()
  })
})
