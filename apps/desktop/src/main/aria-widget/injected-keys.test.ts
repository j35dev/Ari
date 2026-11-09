// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { withInjectedKeys } from './injected-keys'

it.each([false, true])(
  'releases every injected key even when the assertion fails: %s',
  async (fail) => {
    const hook = { keyToggle: vi.fn() }
    const run = withInjectedKeys(hook, [29, 107], async () => {
      if (fail) throw new Error('assertion failed')
    })
    if (fail) await expect(run).rejects.toThrow('assertion failed')
    else await run
    expect(hook.keyToggle.mock.calls).toEqual([
      [29, 'down'],
      [107, 'down'],
      [107, 'up'],
      [29, 'up'],
    ])
  },
)

it('releases keys if injecting a key throws', async () => {
  const hook = {
    keyToggle: vi.fn((key: number, toggle: 'down' | 'up') => {
      if (key === 107 && toggle === 'down') throw new Error('injection failed')
    }),
  }
  await expect(withInjectedKeys(hook, [29, 107], async () => undefined)).rejects.toThrow(
    'injection failed',
  )
  expect(hook.keyToggle.mock.calls.slice(-2)).toEqual([
    [107, 'up'],
    [29, 'up'],
  ])
})
