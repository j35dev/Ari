// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { SessionControls } from './SessionControls'

const app = vi.hoisted(() => ({
  catalog: null as RemoteModelCatalog | null,
  session: {
    supports: vi.fn((_op: string) => false),
    query: vi.fn<(op: string, params: unknown) => Promise<unknown>>(),
  },
}))
vi.mock('../lib/app-state', () => ({ useApp: () => app }))

beforeEach(() => {
  app.session.supports.mockImplementation(() => false)
  app.catalog = {
    providers: [
      {
        driverKind: 'codex',
        models: [{ id: 'gpt', label: 'GPT' }],
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', description: 'Thinks longer', current: true },
        ],
        modes: [],
      },
      { driverKind: 'claude', models: [], efforts: [], modes: [] },
      { driverKind: 'opencode', models: [] },
    ],
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function controls(overrides: Partial<Parameters<typeof SessionControls>[0]> = {}): {
  onEffort: ReturnType<typeof vi.fn>
  onMode: ReturnType<typeof vi.fn>
  onPickModel: ReturnType<typeof vi.fn>
} {
  const handlers = { onEffort: vi.fn(), onMode: vi.fn(), onPickModel: vi.fn() }
  render(
    <SessionControls
      driverKind="codex"
      modelId="gpt"
      modelLabel="Codex · GPT"
      effort={null}
      permissionMode="ask"
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
}

describe('session controls', () => {
  it('shows the model, the effort the agent is using, and the permission mode', () => {
    controls()
    expect(screen.getByRole('button', { name: 'Model: Codex · GPT' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Effort: High' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Permissions: Ask' })).toBeTruthy()
  })

  it('opens the model picker from the model chip', () => {
    const { onPickModel } = controls()
    fireEvent.click(screen.getByRole('button', { name: 'Model: Codex · GPT' }))
    expect(onPickModel).toHaveBeenCalledOnce()
  })

  it('changes effort from a sheet that explains each level', () => {
    const { onEffort } = controls()
    fireEvent.click(screen.getByRole('button', { name: 'Effort: High' }))
    const sheet = screen.getByRole('dialog', { name: 'Effort' })
    expect(sheet.textContent).toContain('Thinks longer')
    expect(screen.getByRole('button', { name: /^High/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    expect(onEffort).toHaveBeenCalledWith('low')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('changes permission mode from a sheet that says what each mode allows', () => {
    const { onMode } = controls()
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }))
    expect(screen.getByRole('dialog', { name: 'Permissions' }).textContent).toContain(
      'Approve everything automatically',
    )
    fireEvent.click(screen.getByRole('button', { name: /^Full auto/ }))
    expect(onMode).toHaveBeenCalledWith('full')
  })

  it('hides the effort chip for a provider with no levels', () => {
    controls({ driverKind: 'claude', modelLabel: 'Claude Code' })
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Permissions: Ask' })).toBeTruthy()
  })

  it('offers only the model against a desktop that cannot accept effort or mode', () => {
    controls({ driverKind: 'opencode', modelLabel: 'OpenCode' })
    expect(screen.getByRole('button', { name: 'Model: OpenCode' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Permissions/ })).toBeNull()
  })

  it('asks the desktop for the selected model’s own levels when it can', async () => {
    app.session.supports.mockImplementation((op) => op === 'models.efforts')
    app.session.query.mockResolvedValue({ efforts: [{ id: 'max', label: 'Max' }] })
    const { onEffort } = controls()
    fireEvent.click(screen.getByRole('button', { name: 'Effort: High' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Max/ }))
    expect(app.session.query).toHaveBeenCalledWith('models.efforts', {
      driverKind: 'codex',
      modelId: 'gpt',
    })
    expect(onEffort).toHaveBeenCalledWith('max')
  })

  it('says a change made mid-turn applies to the next turn', () => {
    controls({ running: true })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }))
    expect(screen.getByRole('dialog').textContent).toContain('Applies to the next turn')
  })

  it('locks every control while disabled', () => {
    controls({ disabled: true })
    for (const chip of screen.getAllByRole('button'))
      expect((chip as HTMLButtonElement).disabled).toBe(true)
  })
})
