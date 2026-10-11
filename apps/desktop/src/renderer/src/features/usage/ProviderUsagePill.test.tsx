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

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function banked(availableCount: number): ProviderAllowance {
  return { ...sample('codex'), resetCredits: { availableCount, nextExpiresAt: null } }
}

const applied = { ok: true, outcome: 'reset', allowance: banked(1) }

/** Codex alone, two resets banked; `redeem` answers each redemption. */
function bankTwo(redeem: () => unknown) {
  invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.detect') return [{ kind: 'codex', installed: true }]
    return method === 'providers.consumeResetCredit' ? redeem() : banked(2)
  })
}

function redemptions(): number {
  return invoke.mock.calls.filter(([method]) => method === 'providers.consumeResetCredit').length
}

/** Leaves every later allowance read pending; the returned resolvers answer them. */
function holdReads() {
  const reads: ((row: ProviderAllowance) => void)[] = []
  const answer = invoke.getMockImplementation()
  invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.allowance') return new Promise((resolve) => reads.push(resolve))
    const other: unknown = await answer?.(method)
    return other
  })
  return reads
}

async function openPill() {
  render(<ProviderUsagePill sessionId="one" kind="codex" />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /Codex usage:/ }))
  await settle()
}

async function confirmReset() {
  fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
  await wait(600)
  fireEvent.click(screen.getByRole('button', { name: 'Use one Codex reset' }))
  await settle()
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

  it('shows a manual refresh running and says when it has finished', async () => {
    invoke.mockImplementation(async (method: string) =>
      method === 'providers.detect' ? [{ kind: 'codex', installed: true }] : sample('codex'),
    )
    await openPill()
    const refresh = screen.getByRole('button', { name: 'Refresh usage' })
    expect(refresh).toBeEnabled()
    expect(screen.getByText('Checked just now · refreshes every minute')).toBeInTheDocument()

    const reads = holdReads()
    fireEvent.click(refresh)
    await settle()
    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(refresh.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByText('Refreshing…')).toBeInTheDocument()

    reads[0]?.({ ...sample('codex'), windows: [{ label: '5h', usedPercent: 40, resetsAt: null }] })
    await settle()
    expect(refresh).not.toHaveAttribute('aria-busy')
    expect(refresh.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByText('Checked just now · refreshes every minute')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Codex 5h used' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    )
  })

  it('marks only the providers still being read, since they answer seconds apart', async () => {
    invoke.mockImplementation(async (method: string, params?: { kind: string }) =>
      method === 'providers.detect'
        ? ['codex', 'grok'].map((kind) => ({ kind, installed: true }))
        : sample(params?.kind ?? 'codex'),
    )
    await openPill()
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument()

    const reads = holdReads()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    await settle()
    expect(screen.getAllByText('Checking…')).toHaveLength(2)

    reads[0]?.(sample('codex'))
    await settle()
    expect(screen.getAllByText('Checking…')).toHaveLength(1)
    expect(screen.getByText('Refreshing…')).toBeInTheDocument()

    reads[1]?.(sample('grok'))
    await settle()
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument()
    expect(screen.getByText('Checked just now · refreshes every minute')).toBeInTheDocument()
  })

  it('names the providers a refresh could not read', async () => {
    invoke.mockImplementation(async (method: string, params?: { kind: string }) => {
      if (method === 'providers.detect')
        return ['codex', 'claude'].map((kind) => ({ kind, installed: true }))
      if (params?.kind === 'claude') throw new Error('adapter exited')
      return sample('codex')
    })
    await openPill()
    expect(screen.getByText('Checked just now · could not read Claude')).toBeInTheDocument()
  })

  it('shows a banked reset and redeems it after confirmation', async () => {
    bankTwo(() => applied)
    await openPill()
    expect(
      screen.getByRole('button', { name: 'Codex usage: 5h 12% used, 2 banked resets' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/^2 resets/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Codex reset' }))
    expect(redemptions()).toBe(0)
    await confirmReset()
    expect(screen.getByRole('status')).toHaveTextContent('Applied')
    expect(screen.getByText(/^1 reset/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('providers.consumeResetCredit', { kind: 'codex' })
  })

  it('does not let a double-click on Use confirm the reset', async () => {
    bankTwo(() => applied)
    await openPill()
    fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
    const confirm = screen.getByRole('button', { name: 'Use one Codex reset' })
    expect(confirm).toBeDisabled()
    expect(confirm.nextElementSibling).toHaveAccessibleName('Cancel Codex reset')
    fireEvent.click(confirm)
    await wait(500)
    fireEvent.click(confirm)
    await settle()
    expect(redemptions()).toBe(0)
    await wait(100)
    expect(confirm).toBeEnabled()
  })

  it('disarms an abandoned confirmation when the popover closes', async () => {
    bankTwo(() => applied)
    await openPill()
    fireEvent.click(screen.getByRole('button', { name: 'Use reset for Codex' }))
    await wait(600)
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Codex usage:/ }))
    await settle()
    expect(screen.queryByRole('button', { name: 'Use one Codex reset' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use reset for Codex' })).toBeInTheDocument()
  })

  it('shows a refusal as worded and lets the reset be tried again', async () => {
    const refusal = 'Claude resets are cooling down. Try again later.'
    const answers: unknown[] = [{ ok: false, error: refusal }, applied]
    bankTwo(() => answers.shift())
    await openPill()
    await confirmReset()
    expect(screen.getByRole('status').textContent).toBe(refusal)
    expect(screen.queryByRole('button', { name: 'Use one Codex reset' })).not.toBeInTheDocument()
    await confirmReset()
    expect(screen.getByRole('status')).toHaveTextContent('Applied')
    expect(redemptions()).toBe(2)
  })

  it('hides transport wording when the call itself breaks, and forgets it on close', async () => {
    bankTwo(() => {
      throw new Error("Error invoking remote method 'ari:providers.consumeResetCredit': boom")
    })
    await openPill()
    await confirmReset()
    expect(screen.getByRole('status').textContent).toBe('Could not use the reset.')
    fireEvent.keyDown(document, { key: 'Escape' })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Codex usage:/ }))
    await settle()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use reset for Codex' })).toBeInTheDocument()
  })

  it('clears the outcome after a moment so the next banked reset can be used', async () => {
    bankTwo(() => applied)
    await openPill()
    await confirmReset()
    expect(screen.queryByRole('button', { name: 'Use reset for Codex' })).not.toBeInTheDocument()
    await wait(4_000)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await confirmReset()
    expect(redemptions()).toBe(2)
  })

  it('lets a pass slower than the minute timer finish instead of restarting it', async () => {
    bankTwo(() => applied)
    const reads = holdReads()
    const hook = renderHook(() => useProviderAllowance('one', 'codex'))
    await settle()
    const probes = () => invoke.mock.calls.filter(([method]) => method === 'providers.allowance')
    expect(probes()).toHaveLength(1)

    await wait(60_000)
    void hook.result.current.refresh()
    await settle()
    expect(probes()).toHaveLength(1)
    expect(hook.result.current.refreshing).toBe(true)

    await act(async () => {
      reads[0]?.(banked(2))
    })
    expect(hook.result.current.rows[0]?.resetCredits?.availableCount).toBe(2)

    // The tick the slow pass swallowed is made up at once, not a minute later,
    // or rows that answered early would sit stale in between.
    await settle()
    expect(probes()).toHaveLength(2)
    await act(async () => {
      reads[1]?.(banked(2))
    })
    expect(hook.result.current.refreshing).toBe(false)
    expect(probes()).toHaveLength(2)
  })

  it('keeps the redeemed allowance when an older refresh answers after it', async () => {
    bankTwo(() => applied)
    const hook = renderHook(() => useProviderAllowance('one', 'codex'))
    await settle()
    const reads = holdReads()
    await act(async () => {
      void hook.result.current.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.refreshing).toBe(true)
    await act(async () => {
      await hook.result.current.consumeReset('codex')
    })
    await act(async () => {
      reads[0]?.(banked(2))
    })
    expect(hook.result.current.refreshing).toBe(false)
    expect(hook.result.current.rows[0]?.resetCredits?.availableCount).toBe(1)
  })

  it('applies a redemption that finishes after a refresh tick started', async () => {
    let redeem: (value: unknown) => void = () => undefined
    bankTwo(() => new Promise((resolve) => (redeem = resolve)))
    const hook = renderHook(() => useProviderAllowance('one', 'codex'))
    await settle()
    const reads = holdReads()
    let outcome: Promise<unknown> = Promise.resolve()
    await act(async () => {
      outcome = hook.result.current.consumeReset('codex')
      await vi.advanceTimersByTimeAsync(60_000)
    })
    await act(async () => {
      redeem(applied)
      await outcome
    })
    expect(hook.result.current.rows[0]?.resetCredits?.availableCount).toBe(1)
    await act(async () => {
      reads[0]?.(banked(2))
    })
    expect(hook.result.current.rows[0]?.resetCredits?.availableCount).toBe(1)
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
