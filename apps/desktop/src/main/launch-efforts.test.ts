// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { launchEffortLookup } from './launch-efforts'

it('uses verified per-model support, including a known model with no effort axis', async () => {
  const probe = vi.fn()
  const lookup = launchEffortLookup({
    known: (_kind, model) => (model === 'reasoning' ? [{ id: 'high' }] : []),
    probe,
  })
  expect(await lookup('codex', 'reasoning')).toEqual([{ id: 'high' }])
  expect(await lookup('codex', 'plain')).toEqual([])
  expect(probe).not.toHaveBeenCalled()
})

it('shares successful discovery and retries a failure instead of caching low or no reasoning', async () => {
  const probe = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([{ id: 'xhigh' }])
  const lookup = launchEffortLookup({ known: () => undefined, probe })
  await expect(lookup('codex', 'sol')).rejects.toMatchObject({ code: 'effort_unavailable' })
  const [one, two] = await Promise.all([lookup('codex', 'sol'), lookup('codex', 'sol')])
  expect(one).toEqual([{ id: 'xhigh' }])
  expect(two).toEqual(one)
  expect(probe).toHaveBeenCalledTimes(2)
  await lookup('codex', 'other-model')
  expect(probe).toHaveBeenCalledTimes(3)
})
