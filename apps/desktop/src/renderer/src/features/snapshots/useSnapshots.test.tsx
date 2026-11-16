import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PendingSnapshot, SnapshotBridge } from '../../../../shared/snapshots'
import { dropDraftIntentMemory, readSessionDraftIntent } from '../composer/draft-recovery-store'
import { useSnapshots } from './useSnapshots'

const settings = vi.hoisted(() => ({ snapshots: { animation: false, sound: false } }))
vi.mock('../settings/useEngineSettings', () => ({ useEngineSettings: () => ({ settings }) }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: vi.fn() } }))

function pending(id: string, capturedAt: number, target?: string): PendingSnapshot {
  return {
    id,
    capturedAt,
    windowTitle: 'Example',
    target,
    attachment: {
      id: `att_${capturedAt}`,
      name: `SnapShot ${capturedAt}.png`,
      mimeType: 'image/png',
      size: 5,
    },
  }
}
const sent = pending('ba92a835-75c9-40d7-b266-6208b845c3ad', 1, 'project-draft:sent')
const later = pending('0c5f3c3e-1f8e-4c1e-9a43-6a3c3a0e6d11', 2)

let queue: PendingSnapshot[]
const bridge = {
  status: vi.fn(),
  pending: vi.fn(async () => queue),
  read: vi.fn(async (id: string) => ({
    ...queue.find((item) => item.id === id)!,
    dataBase64: btoa('image'),
  })),
  target: vi.fn(async (_id: string, target: string) => target),
  acknowledge: vi.fn(async (id: string) => {
    queue = queue.filter((item) => item.id !== id)
  }),
  destination: vi.fn(),
  suppress: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
} satisfies SnapshotBridge

beforeEach(() => {
  localStorage.clear()
  dropDraftIntentMemory()
  queue = [sent, later]
  ;(window as unknown as { ari: { snapshots: SnapshotBridge } }).ari = { snapshots: bridge }
})
afterEach(() => {
  vi.clearAllMocks()
  delete (window as unknown as { ari?: unknown }).ari
})

// App resolves a pin only while its draft exists; Send removes a project draft.
const resolveTarget = (pinned?: string): string | null =>
  pinned?.startsWith('project-draft:') ? null : (pinned ?? 'sess_current')

it('re-pins a capture queued for a project draft that was sent, then drains the rest', async () => {
  const notify = vi.fn()
  renderHook(() => useSnapshots(resolveTarget, notify))
  await waitFor(() => expect(queue).toEqual([]))
  expect(bridge.target).toHaveBeenCalledWith(sent.id, 'sess_current')
  expect(readSessionDraftIntent('sess_current').images.map((image) => image.snapshot?.id)).toEqual([
    sent.id,
    later.id,
  ])
  expect(notify).not.toHaveBeenCalled()
})

it('keeps draining past a capture that cannot attach and reports it once', async () => {
  bridge.read.mockRejectedValueOnce(new Error('The captured image could not be read.'))
  const notify = vi.fn()
  renderHook(() => useSnapshots(resolveTarget, notify))
  await waitFor(() => expect(queue).toEqual([sent]))
  expect(bridge.acknowledge).toHaveBeenCalledWith(later.id)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith('The captured image could not be read.')
})
