// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { pulseOutputBackend } from './audio-ducking-linux'
import { DuckingState } from './audio-ducking-state'

it('targets playback channels, preserves balance, and identifies server/session replacement', async () => {
  let cookie = 'server-one'
  const run = vi.fn(async (args: string[]) =>
    args[0] === 'info'
      ? `Cookie: ${cookie}\n`
      : args[0] === '--format=json'
        ? JSON.stringify([
            {
              index: 7,
              client: 2,
              properties: { 'application.process.id': '100' },
              volume: { left: { value: 65536 }, right: { value: 32768 } },
            },
            {
              index: 8,
              client: 3,
              properties: { 'application.process.id': '200' },
              volume: { mono: { value: 65536 } },
            },
          ])
        : '',
  )
  const backend = pulseOutputBackend(() => new Set([200]), run)
  const { sessions } = await backend.list()
  expect(sessions[0]!.excluded).toBe(false)
  expect(sessions[1]!.excluded).toBe(true)
  expect(await sessions[0]!.read()).toEqual([1, 0.5])
  await sessions[0]!.write([0.25, 0.125])
  expect(run).toHaveBeenCalledWith(['set-sink-input-volume', '7', '16384', '8192'])
  expect(run.mock.calls.flat().flat().join(' ')).not.toMatch(/set-sink-volume|mute|source/)
  cookie = 'server-two'
  expect((await backend.list()).sessions[0]!.id).not.toBe(sessions[0]!.id)
})

it('leaves capture independent of missing tools or malformed stream inventories', async () => {
  const unavailable = pulseOutputBackend(
    () => new Set(),
    async () => {
      throw new Error('pactl missing')
    },
  )
  await expect(unavailable.list()).rejects.toThrow('pactl missing')
  const invalid = pulseOutputBackend(
    () => new Set(),
    async (args) => (args[0] === 'info' ? 'Cookie: one' : '{}'),
  )
  await expect(invalid.list()).rejects.toThrow('Invalid PulseAudio')
})

it('restores nonintegral attenuation without mistaking backend rounding for a user change', async () => {
  let value = 65535
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === 'info') return 'Cookie: stable'
    if (args[0] === 'set-sink-input-volume') {
      value = Number(args[2])
      return ''
    }
    return JSON.stringify([{ index: 7, client: 2, properties: {}, volume: { mono: { value } } }])
  }
  const state = new DuckingState(
    pulseOutputBackend(() => new Set(), run),
    {
      read: async () => [],
      write: async () => undefined,
    },
    (error) => {
      throw error
    },
  )
  await state.setActive(true)
  expect(value).toBe(16384)
  await state.reconcile()
  await state.setActive(false)
  expect(value).toBe(65535)
})
