import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { attachSnapshot } from './attach'
import { useImageAttachments } from '../composer/useImageAttachments'
import {
  dropDraftIntentMemory,
  readSessionDraftIntent,
  updateSessionDraftIntent,
} from '../composer/draft-recovery-store'

const rpc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc }))
const capture = {
  id: 'ba92a835-75c9-40d7-b266-6208b845c3ad',
  capturedAt: Date.now(),
  windowTitle: 'Example',
  attachment: { id: 'att_snapshot', name: 'SnapShot Example.png', mimeType: 'image/png', size: 5 },
  dataBase64: btoa('image'),
}
const preferences = { animation: false, sound: false }
beforeEach(() => {
  localStorage.clear()
  dropDraftIntentMemory()
  rpc.invoke.mockReset()
})
it('lands in the same composer attachment hook as paste/drop without replacing existing images', () => {
  const { result } = renderHook(() => useImageAttachments('sess_current'))
  const pasted = new File(['first'], 'pasted.png', { type: 'image/png' })
  act(() => result.current.addFiles([pasted]))
  act(() => attachSnapshot(capture, 'sess_current', preferences))
  expect(result.current.images.map((file) => file.name)).toEqual([
    'pasted.png',
    'SnapShot Example.png',
  ])
  expect(result.current.intents[1]?.ref).toEqual(capture.attachment)
  expect(readSessionDraftIntent('sess_other').images).toEqual([])
  act(() => attachSnapshot(capture, 'sess_current', preferences))
  expect(result.current.images).toHaveLength(2)
})
it('refuses a full draft and retries after removal', () => {
  const { result } = renderHook(() => useImageAttachments('sess_current'))
  act(() =>
    result.current.addFiles(
      Array.from(
        { length: 4 },
        (_, index) => new File(['a'], `${index}.png`, { type: 'image/png' }),
      ),
    ),
  )
  expect(() => attachSnapshot(capture, 'sess_current', preferences)).toThrow(
    'Remove an attached image',
  )
  act(() => result.current.removeAt(0))
  act(() => attachSnapshot(capture, 'sess_current', preferences))
  expect(result.current.images).toHaveLength(4)
})
it('restores snapshot bytes and durable reference after a renderer restart', async () => {
  attachSnapshot(capture, 'project-draft:one', preferences)
  dropDraftIntentMemory()
  rpc.invoke.mockResolvedValue({
    attachment: { ...capture.attachment, dataBase64: capture.dataBase64 },
  })
  const { result } = renderHook(() => useImageAttachments('project-draft:one'))
  await waitFor(() => expect(result.current.images).toHaveLength(1))
  expect(result.current.images[0]?.size).toBe(5)
  expect(result.current.intents[0]?.snapshot?.localRef).toEqual(capture.attachment)
})
it('keeps a remote draft local until Send, without a local ref in the remote attachment path', () => {
  const target = JSON.stringify(['machine_remote', 'sess_remote'])
  attachSnapshot(capture, target, preferences)
  expect(readSessionDraftIntent(target).images[0]?.ref).toBeUndefined()
  expect(readSessionDraftIntent(target).images[0]?.snapshot?.localRef).toEqual(capture.attachment)
  expect(rpc.invoke).not.toHaveBeenCalled()
})
it('keeps a restoring capture when another window capture has the same filename and size', () => {
  const target = 'project-draft:restoring'
  attachSnapshot(capture, target, preferences)
  dropDraftIntentMemory()
  const next = {
    ...capture,
    id: 'fa92a835-75c9-40d7-b266-6208b845c3ad',
    capturedAt: capture.capturedAt + 1,
    dataBase64: btoa('other'),
  }
  attachSnapshot(next, target, preferences)
  expect(readSessionDraftIntent(target).images.map((image) => image.snapshot?.id)).toEqual([
    capture.id,
    next.id,
  ])
})
it('does not acknowledge attachment delivery when draft persistence fails', () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded')
  })
  expect(() => attachSnapshot(capture, 'sess_current', preferences)).toThrow(
    'could not be persisted',
  )
  write.mockRestore()
  attachSnapshot(capture, 'sess_current', preferences)
  expect(readSessionDraftIntent('sess_current').storageIssue).toBe(false)
  expect(readSessionDraftIntent('sess_current').images).toHaveLength(1)
  updateSessionDraftIntent('sess_current', (state) => ({ ...state, images: [] }))
})
