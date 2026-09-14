import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { ModelSelector } from './ModelSelector'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn((_name: string, _params: unknown, _listener: (payload: unknown) => void) => () => undefined),
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
    rpcMocks.subscribe.mockClear()
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

  it('trigger shows a provider logo plus the model label', async () => {
    setup()
    const trigger = await screen.findByRole('button', { name: /model:/i })
    await waitFor(() => {
      // Claude carries the vendored Anthropic logo (an svg), not a letter chip.
      expect(trigger.querySelector('svg')).not.toBeNull()
      expect(trigger).toHaveTextContent('Sonnet 4.5')
    })
  })

  it('updates an open picker when a late live catalog arrives', async () => {
    setup('codex', 'gpt-5.6')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    const list = screen.getByRole('listbox', { name: 'Models' })
    expect(within(list).getByText('GPT-5.6')).toBeInTheDocument()
    const invoke = rpcMocks.invoke.getMockImplementation()!
    rpcMocks.invoke.mockImplementation(async (method: string) => method === 'providers.models'
      ? [{ kind: 'codex', source: 'live', models: [{ id: 'future-cli-model', label: 'New CLI model' }] }]
      : invoke(method) as Promise<unknown>)
    const listener = rpcMocks.subscribe.mock.calls.find(([name]) => name === 'providers.updates')?.[2]
    expect(listener).toBeDefined()
    await act(async () => listener?.({ type: 'catalog', at: Date.now() }))
    expect(await within(list).findByText('New CLI model')).toBeInTheDocument()
    expect(within(list).queryByText('GPT-5.6')).not.toBeInTheDocument()
  })

  it('opens straight onto the current provider with its active model checked', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    // Rail: every installed provider with its model count.
    const rail = screen.getByRole('presentation', { name: 'Providers' })
    expect(within(rail).getByText('Claude')).toBeInTheDocument()
    expect(within(rail).getByText('Codex')).toBeInTheDocument()

    // Pane: the current provider's models are visible immediately — no drill-in.
    const models = screen.getByRole('listbox', { name: 'Models' })
    expect(within(models).getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(within(models).getByText('Opus 4')).toBeInTheDocument()
    expect(within(models).queryByText('GPT-5.6')).not.toBeInTheDocument()
    expect(within(models).getByRole('option', { selected: true })).toHaveTextContent('Sonnet 4.5')
  })

  it('swaps the pane from the rail and picks across providers with clicks', async () => {
    const { onChange } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    await user.click(within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Codex'))
    const models = screen.getByRole('listbox', { name: 'Models' })
    expect(within(models).getByText('GPT-5.6')).toBeInTheDocument()
    expect(within(models).queryByText('Sonnet 4.5')).not.toBeInTheDocument()

    await user.click(within(models).getByText('GPT-5.6'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'codex', modelId: 'gpt-5.6' })
  })

  it('picks with Enter and moves between providers with Left/Right', async () => {
    const { onChange } = setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    // Enter picks the highlighted model of the open pane directly.
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })

    // Reopen: ArrowRight moves to the next provider, Enter picks its first model.
    await user.click(screen.getByRole('button', { name: /model:/i }))
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'codex', modelId: 'gpt-5.6' })

    // ArrowLeft wraps back to Claude, still on its first model.
    await user.click(screen.getByRole('button', { name: /model:/i }))
    await user.keyboard('{ArrowLeft}{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
  })

  it('search cuts across all providers into grouped results', async () => {
    const { onChange } = setup('codex', 'gpt-5.6')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    await user.type(screen.getByLabelText('Search models'), 'op')
    let results = screen.getByRole('listbox', { name: 'Search results' })
    expect(within(results).getByText('Opus 4')).toBeInTheDocument()
    expect(within(results).queryByText('Sonnet 4.5')).not.toBeInTheDocument()
    expect(within(results).queryByText('GPT-5.6')).not.toBeInTheDocument()

    // ArrowLeft/Right move the text caret while searching — they must not
    // clear the query or jump the provider rail.
    await user.keyboard('{ArrowRight}{ArrowLeft}')
    results = screen.getByRole('listbox', { name: 'Search results' })
    expect(within(results).getByText('Opus 4')).toBeInTheDocument()

    // A different query surfaces another provider under its own group header.
    await user.clear(screen.getByLabelText('Search models'))
    await user.type(screen.getByLabelText('Search models'), 'gpt')
    results = screen.getByRole('listbox', { name: 'Search results' })
    expect(within(results).getByText('GPT-5.6')).toBeInTheDocument()
    expect(within(results).getByText('Codex · 1')).toBeInTheDocument()
    expect(within(results).queryByText('Opus 4')).not.toBeInTheDocument()

    await user.clear(screen.getByLabelText('Search models'))
    await user.type(screen.getByLabelText('Search models'), 'op')
    await user.keyboard('{Home}{Enter}')
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
    })
  })

  it('shows a no-match state for nonsense queries', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.type(screen.getByLabelText('Search models'), 'zzz')
    expect(screen.getByText(/no models match/i)).toBeInTheDocument()
  })

  it('lists every model an endpoint serves and picks the one clicked', async () => {
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
        return [
          {
            id: 'end_1',
            name: 'My Relay',
            model: 'relay-large',
            models: [
              {
                id: 'relay-large',
                label: 'Relay Large',
                contextWindow: 200000,
                source: 'discovered',
              },
              { id: 'relay-small', label: 'Relay Small', contextWindow: null, source: 'manual' },
            ],
          },
        ]
      }
      throw new Error(`unexpected ${String(method)}`)
    })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ModelSelector driverKind='ari-core' modelId={null} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: /model:/i }))
    const models = await screen.findByRole('listbox', { name: 'Models' })
    expect(within(models).getByText('My Relay · Relay Large')).toBeInTheDocument()
    await user.click(within(models).getByText('My Relay · Relay Small'))

    // driverKind stays 'ari-core'; splitting the handle on ':' once sent 'ep',
    // which failed session.create the moment a custom endpoint existed.
    expect(onChange).toHaveBeenCalledWith({
      driverKind: 'ari-core',
      modelId: 'ep:end_1:relay-small',
    })
  })

  it('shows the endpoint and model names, not the raw ep: handle, on the trigger', async () => {
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') {
        return [
          {
            id: 'end_1',
            name: 'My Relay',
            model: 'relay-large',
            models: [
              { id: 'relay-large', label: 'Relay Large', contextWindow: null, source: 'manual' },
            ],
          },
        ]
      }
      throw new Error(`unexpected ${String(method)}`)
    })
    render(
      <ModelSelector driverKind='ari-core' modelId='ep:end_1:relay-large' onChange={vi.fn()} />,
    )

    const trigger = await screen.findByRole('button', { name: /model:/i })
    expect(trigger).toHaveTextContent('My Relay · Relay Large')
    expect(trigger).not.toHaveTextContent('ep:end_1')
  })

  it('resolves a legacy bare ep: handle to its endpoint label', async () => {
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') {
        return [
          {
            id: 'end_1',
            name: 'My Relay',
            model: 'relay-large',
            models: [
              { id: 'relay-large', label: 'Relay Large', contextWindow: null, source: 'manual' },
            ],
          },
        ]
      }
      throw new Error(`unexpected ${String(method)}`)
    })
    render(<ModelSelector driverKind='ari-core' modelId='ep:end_1' onChange={vi.fn()} />)

    const trigger = await screen.findByRole('button', { name: /model:/i })
    expect(trigger).toHaveTextContent('My Relay · Relay Large')
  })

  it('shows a loading empty state before catalogs resolve', async () => {
    rpcMocks.invoke.mockImplementation(() => new Promise(() => undefined))
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /model:/i }))
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('lockedTo hides the rail and explains the lock', async () => {
    const { onChange } = setup('claude', 'sonnet-4', 'claude')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))

    // Only the session provider's models; no rail, no other providers.
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    expect(within(listbox).getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(screen.queryByRole('presentation', { name: 'Providers' })).not.toBeInTheDocument()
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    expect(screen.getByText(/start a new session to use another agent/i)).toBeInTheDocument()

    // Picking the still-offered model keeps working and stays on the driver.
    await user.click(within(listbox).getByText('Opus 4'))
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
  })

  describe('provider readiness', () => {
    /** Replace the detected providers for one test. */
    function detectAs(rows: unknown[]): void {
      const base = rpcMocks.invoke.getMockImplementation()!
      rpcMocks.invoke.mockImplementation(async (method: string) =>
        method === 'providers.detect' ? rows : (base(method) as Promise<unknown>),
      )
    }

    it('hides a provider whose CLI is not installed and says why', async () => {
      // The reported case: Claude Code present, Codex never installed — yet
      // `providers.models` still returns a full Codex catalog, so the rail has
      // to gate on the detection rather than on the catalog being non-empty.
      detectAs([
        {
          kind: 'claude',
          installed: true,
          binaryPath: 'C:/bin/claude',
          version: '1',
          authStatus: 'authenticated',
        },
        { kind: 'codex', installed: false, binaryPath: null, version: null, authStatus: 'unknown' },
      ])
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const rail = screen.getByRole('presentation', { name: 'Providers' })
      expect(within(rail).getByText('Claude')).toBeInTheDocument()
      expect(within(rail).queryByText('Codex')).not.toBeInTheDocument()
      // ...and the picker explains the absence instead of going quiet about it.
      expect(screen.getByText(/not installed/i)).toBeInTheDocument()
    })

    it('hides a provider that is installed but logged out', async () => {
      detectAs([
        {
          kind: 'claude',
          installed: true,
          binaryPath: 'C:/bin/claude',
          version: '1',
          authStatus: 'authenticated',
        },
        {
          kind: 'codex',
          installed: true,
          binaryPath: 'C:/bin/codex',
          version: '1',
          authStatus: 'unauthenticated',
        },
      ])
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const rail = screen.getByRole('presentation', { name: 'Providers' })
      expect(within(rail).getByText('Claude')).toBeInTheDocument()
      expect(within(rail).queryByText('Codex')).not.toBeInTheDocument()
      expect(screen.getByText(/not signed in/i)).toBeInTheDocument()
    })

    it('keeps offering a provider whose auth verdict is unknown', async () => {
      // No ~/.claude credentials file, but ANTHROPIC_API_KEY may still work —
      // "Ari cannot tell" must not hide a usable provider.
      detectAs([
        { kind: 'claude', installed: true, binaryPath: 'C:/bin/claude', version: '1', authStatus: 'unknown' },
      ])
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const rail = screen.getByRole('presentation', { name: 'Providers' })
      expect(within(rail).getByText('Claude')).toBeInTheDocument()
    })

    it('keeps a locked session on its own models even when that provider is withheld', async () => {
      detectAs([
        {
          kind: 'claude',
          installed: true,
          binaryPath: 'C:/bin/claude',
          version: '1',
          authStatus: 'authenticated',
        },
        {
          kind: 'codex',
          installed: true,
          binaryPath: 'C:/bin/codex',
          version: '1',
          authStatus: 'unauthenticated',
        },
      ])
      setup('codex', 'gpt-5.6', 'codex')
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      // A mid-session logout must not swap the pane onto another provider.
      const listbox = screen.getByRole('listbox', { name: 'Models' })
      expect(within(listbox).getByText('GPT-5.6')).toBeInTheDocument()
    })
  })

  describe('legacy models', () => {
    /** Replace the served catalogs for one test. */
    function modelsAs(rows: unknown[]): void {
      const base = rpcMocks.invoke.getMockImplementation()!
      rpcMocks.invoke.mockImplementation(async (method: string) =>
        method === 'providers.models' ? rows : (base(method) as Promise<unknown>),
      )
    }

    const opusCatalog = [
      {
        kind: 'claude',
        source: 'live',
        models: [
          { id: 'claude-opus-5', label: 'Claude Opus 5', aliases: ['opus'] },
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', isLegacy: true },
        ],
      },
    ]

    it('collapses superseded models behind a disclosure', async () => {
      modelsAs(opusCatalog)
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const models = screen.getByRole('listbox', { name: 'Models' })
      expect(within(models).getByText('Claude Opus 5')).toBeInTheDocument()
      expect(within(models).queryByText('Claude Opus 4.8')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /older/i }))
      expect(within(models).getByText('Claude Opus 4.8')).toBeInTheDocument()
    })

    it('checks the row a version-less saved id resolves to', async () => {
      modelsAs(opusCatalog)
      // The session was saved against the version-less id the CLI accepts.
      setup('claude', 'opus')
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const models = screen.getByRole('listbox', { name: 'Models' })
      const selected = within(models).getByRole('option', { selected: true })
      expect(selected).toHaveTextContent('Claude Opus 5')
    })

    it('names the resolved row on the trigger, not the raw saved id', async () => {
      modelsAs(opusCatalog)
      setup('claude', 'opus')
      expect(await screen.findByRole('button', { name: /model:/i })).toHaveTextContent(
        'Claude Opus 5',
      )
    })
  })

  describe('catalog provenance', () => {
    /** Replace the served catalogs for one test. */
    function modelsAs(rows: unknown[]): void {
      const base = rpcMocks.invoke.getMockImplementation()!
      rpcMocks.invoke.mockImplementation(async (method: string) =>
        method === 'providers.models' ? rows : (base(method) as Promise<unknown>),
      )
    }

    const bundled = [
      {
        kind: 'claude',
        source: 'snapshot',
        models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }],
      },
    ]

    it('marks a list the agent has not confirmed as bundled, not live', async () => {
      modelsAs(bundled)
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      // A snapshot names models the agent may refuse outright, so the picker
      // says where the list came from instead of implying the agent offered it.
      expect(screen.getByText(/bundled list/i)).toBeInTheDocument()
    })

    it('does not mark a list the agent reported itself', async () => {
      modelsAs([
        {
          kind: 'claude',
          source: 'live',
          models: [{ id: 'sonnet', label: 'Sonnet' }],
        },
      ])
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))
      expect(screen.queryByText(/bundled list/i)).not.toBeInTheDocument()
    })

    it('re-reads the catalogs when the refresh control is used', async () => {
      modelsAs(bundled)
      setup()
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))
      const before = rpcMocks.invoke.mock.calls.filter(([m]) => m === 'providers.models').length

      await user.click(screen.getByRole('button', { name: /refresh/i }))
      expect(
        rpcMocks.invoke.mock.calls.filter(([m]) => m === 'providers.models').length,
      ).toBeGreaterThan(before)
    })
  })
})
