import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAllowance } from '@ari/contracts/rpc'
import { ProviderUsagePill } from './ProviderUsagePill'
import { useProviderAllowance } from './use-provider-allowance'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

function sample(kind: string): ProviderAllowance {
  return {
    kind,
    status: kind === 'claude' ? 'unavailable' : 'available',
    windows:
      kind === 'claude'
        ? []
        : [
            { label: 'Weekly', usedPercent: 23, resetsAt: Date.now() + 86400000 },
            ...(kind === 'codex'
              ? [{ label: '5h', usedPercent: 12, resetsAt: Date.now() + 3600000 }]
              : []),
          ],
    checkedAt: Date.now(),
    updatedAt: kind === 'claude' ? null : Date.now(),
    detail: '',
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset().mockImplementation(async (method: string, params?: { kind: string }) => {
    if (method === 'providers.detect')
      return ['codex', 'grok', 'claude'].map((kind) => ({ kind, installed: true }))
    return sample(params?.kind ?? 'codex')
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('provider allowance pill', () => {
  it('prefers 5h in the closed pill and lists all providers with weekly fallback', async () => {
    const view = render(<ProviderUsagePill sessionId="one" kind="codex" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Codex usage: 5h 12% used' }))
    await settle()
    expect(screen.getByRole('dialog', { name: 'Provider usage' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Codex 5h used' })).toHaveAttribute(
      'aria-valuenow',
      '12',
    )
    expect(screen.getByRole('progressbar', { name: 'Grok Weekly used' })).toHaveAttribute(
      'aria-valuenow',
      '23',
    )
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument()
    view.rerender(<ProviderUsagePill sessionId="two" kind="grok" />)
    await settle()
    expect(screen.getByRole('button', { name: 'Grok usage: Weekly 23% used' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    expect(screen.getByRole('button', { name: 'Grok usage: Weekly 23% used' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('refetches every 60 seconds, on same-provider session switches, and clears timers on unmount', async () => {
    const hook = renderHook(({ id }) => useProviderAllowance(id, 'codex'), {
      initialProps: { id: 'one' },
    })
    await settle()
    expect(invoke.mock.calls.filter(([method]) => method === 'providers.allowance')).toHaveLength(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(invoke.mock.calls.filter(([method]) => method === 'providers.allowance')).toHaveLength(6)
    hook.rerender({ id: 'two' })
    await settle()
    expect(invoke.mock.calls.filter(([method]) => method === 'providers.allowance')).toHaveLength(9)
    hook.unmount()
    const count = invoke.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(invoke.mock.calls).toHaveLength(count)
  })

  it('prefers provider-suffixed 5h windows for pi', async () => {
    invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return [{ kind: 'pi', installed: true }]
      return {
        kind: 'pi',
        status: 'available',
        windows: [
          { label: 'Anthropic 7d', usedPercent: 50, resetsAt: null },
          { label: 'Anthropic 5h', usedPercent: 12, resetsAt: null },
          { label: 'Codex 5h', usedPercent: 34, resetsAt: null },
        ],
        checkedAt: Date.now(),
        updatedAt: Date.now(),
        detail: '',
      } satisfies ProviderAllowance
    })
    render(<ProviderUsagePill sessionId="one" kind="pi" />)
    await settle()
    expect(
      screen.getByRole('button', { name: 'Pi usage: Anthropic 5h 12% used' }),
    ).toBeInTheDocument()
  })

  it('retains the last reading as stale when refreshing fails', async () => {
    render(<ProviderUsagePill sessionId="one" kind="codex" />)
    await settle()
    invoke.mockRejectedValue(new Error('offline'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(
      screen.getByRole('button', { name: 'Codex usage: 5h 12% used, stale' }),
    ).toBeInTheDocument()
  })

  it('shows a banked reset and redeems it after confirmation', async () => {
    const expiresAt = Date.now() + 86_400_000
    invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return [{ kind: 'codex', installed: true }]
      if (method === 'providers.consumeResetCredit') {
        return {
          outcome: 'reset',
          allowance: {
            ...sample('codex'),
            resetCredits: { availableCount: 1, nextExpiresAt: expiresAt },
          },
        }
      }
      return {
        ...sample('codex'),
        resetCredits: { availableCount: 2, nextExpiresAt: expiresAt },
      }
    })
    render(<ProviderUsagePill sessionId="one" kind="codex" />)
    await settle()
    fireEvent.click(
      screen.getByRole('button', { name: 'Codex usage: 5h 12% used, 2 banked resets' }),
    )
    await settle()
    expect(screen.getByText(/^2 resets/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Codex reset' }))
    expect(invoke.mock.calls.some(([method]) => method === 'providers.consumeResetCredit')).toBe(
      false,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use one Codex reset' }))
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Applied')
    expect(screen.getByText(/^1 reset/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('providers.consumeResetCredit', { kind: 'codex' })
  })

  it('lists each reset when their expiries differ', async () => {
    const now = Date.now()
    invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.detect') return [{ kind: 'claude', installed: true }]
      return {
        ...sample('claude'),
        resetCredits: {
          availableCount: 3,
          nextExpiresAt: now + 3 * 86_400_000,
          credits: [
            { expiresAt: now + 17 * 86_400_000 },
            { expiresAt: now + 17 * 86_400_000 },
            { expiresAt: now + 3 * 86_400_000 },
          ],
        },
      }
    })
    render(<ProviderUsagePill sessionId="one" kind="claude" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Claude usage:/ }))
    await settle()
    expect(screen.getByText('3d · 1 reset')).toBeInTheDocument()
    expect(screen.getByText('17d · 2 resets')).toBeInTheDocument()
    expect(screen.queryByText(/^3 resets/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use reset for Claude' })).toHaveAttribute(
      'title',
      'Uses the soonest reset',
    )
  })

  it('ignores late discovery from the previous session', async () => {
    let resolveOld: (value: unknown) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const hook = renderHook(({ id }) => useProviderAllowance(id, 'codex'), {
      initialProps: { id: 'one' },
    })
    hook.rerender({ id: 'two' })
    await settle()
    await act(async () => {
      resolveOld([{ kind: 'pi', installed: true }])
    })
    expect(hook.result.current.rows.map((row) => row.kind)).toEqual(['codex', 'grok', 'claude'])
  })
})
