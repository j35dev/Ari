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

function replyWith(method: string, value: unknown): void {
  const invoke = rpcMocks.invoke.getMockImplementation()!
  rpcMocks.invoke.mockImplementation(async (name: string) =>
    name === method ? value : (invoke(name) as Promise<unknown>),
  )
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
    expect(within(results).getByText('Codex')).toBeInTheDocument()
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

  it('opens and scrolls to a selected model deep in the catalog', async () => {
    replyWith('providers.models', [{
      kind: 'pi', source: 'live',
      models: Array.from({ length: 50 }, (_, i) => ({
        id: `agentrouter/model-${i}`, label: `Model ${i}`,
      })),
    }])
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    const scrolled: HTMLElement[] = []
    const scroll = vi.fn(function (this: HTMLElement) { scrolled.push(this) })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
    try {
      const { onChange } = setup('pi', 'agentrouter/model-42', 'pi')
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))
      const selected = screen.getByRole('option', { selected: true })
      expect(selected).toHaveTextContent('Model 42')
      expect(selected).toHaveClass('bg-accent-subtle')
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', selected.id)
      expect(scrolled).toContain(selected)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
      await user.keyboard('{Enter}')
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'pi', modelId: 'agentrouter/model-42' })
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it('keeps the selected highlight separate from hover and restores it on reopen', async () => {
    const { onChange } = setup('claude', 'opus-4', 'claude')
    const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: /model:/i })
    await user.click(trigger)
    const selected = screen.getByRole('option', { selected: true })
    const other = screen.getByRole('option', { name: /Sonnet/ })
    await user.hover(other)
    expect(selected).toHaveClass('bg-accent-subtle')
    expect(other).toHaveClass('bg-surface-2')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', other.id)
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await user.click(trigger)
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-activedescendant', screen.getByRole('option', { selected: true }).id,
    )
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
  })

  it('searches only the locked provider and never offers a foreign keyboard choice', async () => {
    const { onChange } = setup('claude', 'sonnet-4', 'claude')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    const search = screen.getByRole('combobox')
    await user.type(search, 'gpt')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/no models match/i)).toBeInTheDocument()
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    await user.keyboard('{End}{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    await user.clear(search)
    await user.type(search, 'op')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'opus-4' })
  })

  it('excludes foreign search results even when their model labels match', async () => {
    replyWith('providers.models', [
      { kind: 'claude', source: 'live', models: [{ id: 'sonnet-4', label: 'Shared model' }] },
      { kind: 'codex', source: 'live', models: [{ id: 'gpt-5.6', label: 'Shared model' }] },
    ])
    const { onChange } = setup('claude', 'sonnet-4', 'claude')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.type(screen.getByRole('combobox'), 'shared')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    await user.keyboard('{End}{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'claude', modelId: 'sonnet-4' })
  })

  it('pins an already-open pane and its search when the provider lock arrives', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ModelSelector driverKind="claude" modelId="sonnet-4" onChange={onChange} />,
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.click(within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Codex'))
    expect(screen.getByRole('option')).toHaveTextContent('GPT-5.6')
    rerender(<ModelSelector driverKind="claude" modelId="sonnet-4" onChange={onChange} lockedTo="claude" />)
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Sonnet 4.5')
    expect(screen.queryByText('GPT-5.6')).not.toBeInTheDocument()
    await user.type(screen.getByRole('combobox'), 'gpt')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('highlights the current selection when its catalog arrives after opening', async () => {
    setup('codex', 'future-cli-model', 'codex')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    replyWith('providers.models', [{ kind: 'codex', source: 'live', models: [
      { id: 'gpt-5.6', label: 'GPT-5.6' }, { id: 'future-cli-model', label: 'New CLI model' },
    ] }])
    const listener = rpcMocks.subscribe.mock.calls.find(([name]) => name === 'providers.updates')?.[2]
    await act(async () => listener?.({ type: 'catalog', at: Date.now() }))
    const selected = await screen.findByRole('option', { selected: true })
    expect(selected).toHaveClass('bg-accent-subtle')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', selected.id)
  })

  it('keeps the keyboard candidate on the same model when catalogs reorder', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    await user.keyboard('{ArrowDown}')
    replyWith('providers.models', [{ kind: 'claude', source: 'live', models: [
      { id: 'opus-4', label: 'Opus 4' }, { id: 'sonnet-4', label: 'Sonnet 4.5' },
    ] }])
    const listener = rpcMocks.subscribe.mock.calls.find(([name]) => name === 'providers.updates')?.[2]
    await act(async () => listener?.({ type: 'catalog', at: Date.now() }))
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-activedescendant', screen.getByRole('option', { name: /Opus/ }).id,
    )
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Sonnet 4.5')
  })

  it.each(['ep:end_1:llama3.1:8b', 'ep:end_1'])(
    'highlights endpoint selection %s without guessing the first model', async (modelId) => {
      replyWith('endpoints.list', [{
        id: 'end_1', name: 'My Relay', model: 'llama3.1:8b', models: [
          { id: 'relay-small', label: 'Relay Small', contextWindow: null },
          { id: 'llama3.1:8b', label: 'Llama 3.1', contextWindow: null },
        ],
      }])
      const { onChange } = setup('ari-core', modelId, 'ari-core')
      const user = userEvent.setup()
      const trigger = await screen.findByRole('button', { name: /model:/i })
      await waitFor(() => expect(trigger).toHaveTextContent('My Relay · Llama 3.1'))
      await user.click(trigger)
      const selected = screen.getByRole('option', { selected: true })
      expect(selected).toHaveClass('bg-accent-subtle')
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', selected.id)
      await user.type(screen.getByRole('combobox'), 'small')
      expect(screen.getAllByRole('option')).toHaveLength(1)
      expect(screen.getByRole('option')).toHaveTextContent('My Relay · Relay Small')
      await user.clear(screen.getByRole('combobox'))
      await user.keyboard('{Enter}')
      expect(onChange).toHaveBeenCalledWith({ driverKind: 'ari-core', modelId: 'ep:end_1:llama3.1:8b' })
    },
  )

  it('does not mark a default-suffixed model when the selected endpoint id ends in a colon', async () => {
    replyWith('endpoints.list', [{
      id: 'end_1', name: 'My Relay', model: 'model:', models: [
        { id: 'model:default', label: 'Other model', contextWindow: null },
        { id: 'model:', label: 'Current model', contextWindow: null },
      ],
    }])
    const { onChange } = setup('ari-core', 'ep:end_1:model:', 'ari-core')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /model:/i }))
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Current model')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({ driverKind: 'ari-core', modelId: 'ep:end_1:model:' })
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
      await user.type(screen.getByRole('combobox'), 'gpt')
      expect(screen.getByRole('option')).toHaveTextContent('GPT-5.6')
      expect(screen.queryByText('Claude')).not.toBeInTheDocument()
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

    it('opens the older models when the session is already on one', async () => {
      modelsAs(opusCatalog)
      setup('claude', 'claude-opus-4-8')
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /model:/i }))

      const models = screen.getByRole('listbox', { name: 'Models' })
      expect(within(models).getByRole('option', { selected: true })).toHaveTextContent(
        'Claude Opus 4.8',
      )
      expect(screen.getByRole('combobox')).toHaveAttribute(
        'aria-activedescendant', within(models).getByRole('option', { selected: true }).id,
      )
    })

    it('treats no saved model as the agent default and says what that is', async () => {
      modelsAs([
        {
          kind: 'claude',
          source: 'live',
          models: [
            { id: 'default', label: 'Default (recommended)', description: 'Opus 5.5' },
            { id: 'opus', label: 'Opus 5.5', description: 'For complex work' },
          ],
        },
      ])
      setup('claude', null)
      const user = userEvent.setup()
      const trigger = await screen.findByRole('button', { name: /model:/i })
      // The model that will run, not the word "Default".
      await waitFor(() => expect(trigger).toHaveTextContent('Opus 5.5'))
      expect(trigger).not.toHaveTextContent('Default')

      await user.click(trigger)
      const models = screen.getByRole('listbox', { name: 'Models' })
      const selected = within(models).getByRole('option', { selected: true })
      // The agent's "(recommended)" suffix is dropped from the row name.
      expect(selected).toHaveTextContent('Default')
      expect(selected).not.toHaveTextContent('recommended')
    })

    it('names and checks the model the agent is set to when there is no pick', async () => {
      modelsAs([
        {
          kind: 'claude',
          source: 'live',
          defaultModelId: 'sonnet',
          models: [
            { id: 'default', label: 'Default (recommended)', description: 'Opus 5.5' },
            { id: 'opus', label: 'Opus 5.5' },
            { id: 'sonnet', label: 'Sonnet 5.5' },
          ],
        },
      ])
      setup('claude', null)
      const user = userEvent.setup()
      const trigger = await screen.findByRole('button', { name: /model:/i })
      // The CLI's own settings pick Sonnet, so that is what a no-pick session runs.
      await waitFor(() => expect(trigger).toHaveTextContent('Sonnet 5.5'))

      await user.click(trigger)
      const models = screen.getByRole('listbox', { name: 'Models' })
      expect(within(models).getByRole('option', { selected: true })).toHaveTextContent(
        'Sonnet 5.5',
      )
    })

    it('keeps a registry pick checked once the agent lists that model its own way', async () => {
      modelsAs([
        {
          kind: 'claude',
          source: 'live',
          models: [
            { id: 'opus', label: 'Opus 5.5' },
            { id: 'sonnet', label: 'Sonnet 5.5' },
          ],
        },
      ])
      // Saved from the registry's list before Claude had answered.
      setup('claude', 'claude-opus-5-5')
      const user = userEvent.setup()
      const trigger = await screen.findByRole('button', { name: /model:/i })
      await waitFor(() => expect(trigger).toHaveTextContent('Opus 5.5'))
      expect(trigger).not.toHaveTextContent('claude-opus-5-5')

      await user.click(trigger)
      const models = screen.getByRole('listbox', { name: 'Models' })
      expect(within(models).getByRole('option', { selected: true })).toHaveTextContent('Opus 5.5')
    })

    it('names the agent rather than a placeholder before it has reported', async () => {
      modelsAs([
        { kind: 'claude', source: 'static', models: [{ id: 'default', label: 'CLI default' }] },
      ])
      setup('claude', null)
      const trigger = await screen.findByRole('button', { name: /model:/i })
      await waitFor(() => expect(trigger).toHaveTextContent('Claude'))
      expect(trigger).not.toHaveTextContent('CLI default')
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
