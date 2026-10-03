// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { ModelPicker, modelSelectionLabel } from './ModelPicker'

const app = vi.hoisted(() => ({
  catalog: null as RemoteModelCatalog | null,
  refreshing: false,
  refresh: vi.fn(async () => {}),
}))
vi.mock('../lib/app-state', () => ({ useApp: () => app }))
beforeEach(() => {
  app.catalog = {
    providers: [
      { driverKind: 'codex', available: true, models: [{ id: 'gpt-6.1', label: 'GPT 6.1' }] },
      {
        driverKind: 'opencode',
        available: true,
        models: [
          { id: 'anthropic/claude-sonnet', label: 'Sonnet' },
          { id: 'openai/gpt-6.1', label: 'GPT 6.1 via OpenCode' },
        ],
      },
      {
        driverKind: 'claude',
        available: false,
        reason: 'Sign in to Claude on your computer.',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      },
    ],
    defaults: {
      driverKind: 'opencode',
      modelId: null,
      configuredDriverKind: 'opencode',
      permissionMode: 'ask',
    },
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function picker(fixedProvider = false): {
  select: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const select = vi.fn()
  const close = vi.fn()
  render(
    <ModelPicker
      driverKind="opencode"
      modelId=""
      fixedProvider={fixedProvider}
      onSelect={select}
      onClose={close}
    />,
  )
  return { select, close }
}

describe('desktop model picker', () => {
  it('searches the desktop list and sends the exact native model ID', () => {
    const { select, close } = picker()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), {
      target: { value: 'openai/' },
    })
    expect(screen.queryByRole('button', { name: /^Sonnet/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /GPT 6.1 via OpenCode/ }))
    expect(select).toHaveBeenCalledWith('opencode', 'openai/gpt-6.1')
    expect(close).toHaveBeenCalledOnce()
  })

  it('resets the search when switching agents and exposes only their models', () => {
    const { select } = picker()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sonnet' } })
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: /^GPT 6.1/ }))
    expect(select).toHaveBeenCalledWith('codex', 'gpt-6.1')
  })

  it('explains an unavailable agent and cannot select its models', () => {
    const { select } = picker()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    expect(screen.getByRole('status').textContent).toContain('Sign in to Claude')
    expect(screen.queryByRole('button', { name: 'Provider default' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Sonnet/ })).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('preserves desktop defaults without baking their current IDs into a request', () => {
    const { select } = picker()
    fireEvent.click(screen.getByRole('button', { name: /^Desktop default/ }))
    expect(select).toHaveBeenCalledWith('', '')
  })

  it('keeps an existing session within its own provider', () => {
    picker(true)
    expect(screen.queryByRole('button', { name: 'Codex' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Desktop default/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Sonnet/ })).toBeTruthy()
  })

  it('retains an unknown current native model ID in the displayed label', () => {
    expect(modelSelectionLabel(app.catalog, 'opencode', 'private/model')).toBe(
      'OpenCode · private/model',
    )
  })

  it('shows the effective desktop agent when no explicit mobile choice is made', () => {
    expect(modelSelectionLabel(app.catalog, '', '')).toBe('Desktop default · OpenCode')
  })
})
