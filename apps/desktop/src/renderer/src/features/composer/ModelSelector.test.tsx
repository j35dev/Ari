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
              source: 'static',
              models: [
                { id: 'sonnet-4', label: 'Sonnet 4.5', contextHint: '200k' },
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

  it('trigger shows a letter mark plus the model label', async () => {
    setup()
    const trigger = await screen.findByRole('button', { name: /model:/i })
    await waitFor(() => {
      expect(trigger).toHaveTextContent('C')
      expect(trigger).toHaveTextContent('Sonnet 4.5')
    })
  })

  it('opens a grouped, searchable menu and selects with keyboard', async () => {
    const { onChange } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(within(listbox).getByText('Claude')).toBeInTheDocument()
    expect(within(listbox).getByText('Codex')).toBeInTheDocument()
    expect(within(listbox).getByText('200k')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Search models'), 'gpt')
    expect(within(listbox).getByText('GPT-5.6')).toBeInTheDocument()
    expect(within(listbox).queryByText('Sonnet 4.5')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('Search models'))
    await user.keyboard('{Home}{Enter}')

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
    })
  })

  it('marks the active model and picks on click', async () => {
    const { onChange } = setup('codex', 'gpt-5.6')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    const listbox = screen.getByRole('listbox', { name: 'Models' })
    const active = within(listbox).getByRole('option', { selected: true })
    expect(active).toHaveTextContent('GPT-5.6')

    await user.click(within(listbox).getByText('Sonnet 4.5'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
  })

  it('shows a loading empty state before catalogs resolve', async () => {
    rpcMocks.invoke.mockImplementation(() => new Promise(() => undefined))
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /model:/i }))
    expect(screen.getByText(/loading models/i)).toBeInTheDocument()
  })

  it('shows a no-match state for nonsense queries', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.type(screen.getByLabelText('Search models'), 'zzz')
    expect(screen.getByText(/no models match/i)).toBeInTheDocument()
  })
})
