import { expect, it, vi } from 'vitest'
import { emptyArchive } from './empty-archive'

it('deletes confirmed archived trees child first and keeps surviving parents', async () => {
  const rows = [
    { id: 'parent', archived: true },
    { id: 'child', archived: true, parentSessionId: 'parent' },
    { id: 'partly-restored', archived: true },
    { id: 'restored', archived: false, parentSessionId: 'partly-restored' },
    { id: 'partly-failed', archived: true },
    { id: 'locked', archived: true, parentSessionId: 'partly-failed' },
    { id: 'new-to-archive', archived: true },
  ]
  const destroy = vi.fn(async ({ id }: { id: string }) => {
    if (id === 'locked') throw new Error('File is locked')
    return true
  })

  const deleted = await emptyArchive(
    rows,
    rows.slice(0, -1).map((row) => row.id),
    destroy,
  )
  expect(deleted).toEqual(['child', 'parent'])
  const calls = destroy.mock.calls.map(([row]) => row.id)
  expect([...calls].sort()).toEqual(['child', 'locked', 'parent'])
  expect(calls.indexOf('child')).toBeLessThan(calls.indexOf('parent'))
})

it('starts other trees while one is waiting on cleanup', async () => {
  let finish!: (deleted: boolean) => void
  const slow = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  const destroy = vi.fn(({ id }: { id: string }) => (id === 'slow' ? slow : Promise.resolve(true)))
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: String(i), archived: true }))
  rows[0] = { id: 'slow', archived: true }
  const result = emptyArchive(
    rows,
    rows.map(({ id }) => id),
    destroy,
  )
  expect(destroy).toHaveBeenCalledTimes(4)
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(8))
  finish(true)
  expect(await result).toHaveLength(8)
})
