import { afterEach, beforeEach, expect, it } from 'vitest'
import fixture from '../../../../main/testing/release-profile-0312.fixture.json'
import { dropDraftTextMemory, readSessionDraftText } from './use-drafts'
import {
  dropDraftIntentMemory,
  readSessionDraftIntent,
  updateSessionDraftIntent,
} from './draft-recovery-store'

beforeEach(() => {
  localStorage.clear()
  dropDraftTextMemory()
  dropDraftIntentMemory()
  for (const [key, value] of Object.entries(fixture.rendererStorage))
    localStorage.setItem(key, value)
})
afterEach(() => {
  localStorage.clear()
  dropDraftTextMemory()
  dropDraftIntentMemory()
})

it('hydrates frozen 0.3.12 draft/attachment intent conservatively without submitting or dropping work', () => {
  const { parentId, attachment } = fixture.expected
  const original = Object.fromEntries(
    Object.keys(fixture.rendererStorage).map((key) => [key, localStorage.getItem(key)]),
  )
  expect(readSessionDraftText(parentId)).toBe('Unsent synthetic draft — do not submit.')
  const hydrated = readSessionDraftIntent(parentId)
  expect(hydrated.pendingId).toBeUndefined()
  expect(hydrated.delivery).toBe('uncertain')
  expect(hydrated.images[0]).toMatchObject({
    ref: attachment,
    metadata: { name: 'synthetic.png', size: 68 },
  })
  expect(hydrated.images[0]?.file).toBeUndefined()
  expect(
    hydrated.recoveries.map((entry) => ({
      id: entry.id,
      delivery: entry.delivery,
      autoRestore: entry.autoRestore,
      files: entry.files,
    })),
  ).toEqual([
    { id: 'send_preparing', delivery: 'unsent', autoRestore: false, files: [] },
    { id: 'send_pending', delivery: 'uncertain', autoRestore: false, files: [] },
  ])
  expect(hydrated.recoveries[0]?.reattachRequired).toBe(true)
  expect(hydrated.recoveries[0]?.images[0]?.metadata.name).toBe('synthetic.png')
  expect(hydrated.recoveries[1]?.images[0]?.ref).toEqual(attachment)
  expect(hydrated.recoveries[1]?.notes).toMatchObject([
    { id: 'note_preserved', path: 'src/example.ts', line: 3 },
  ])
  expect(
    Object.fromEntries(Object.keys(original).map((key) => [key, localStorage.getItem(key)])),
  ).toEqual(original)
  // Persisting another session after hydration must keep the restored original work.
  updateSessionDraftIntent(fixture.expected.runningId, (state) => ({
    ...state,
    delivery: 'uncertain',
  }))
  dropDraftTextMemory()
  dropDraftIntentMemory()
  expect(readSessionDraftText(parentId)).toBe('Unsent synthetic draft — do not submit.')
  const reloaded = readSessionDraftIntent(parentId)
  expect(reloaded.recoveries).toEqual(hydrated.recoveries)
  expect(reloaded.images).toEqual(hydrated.images)
  expect(readSessionDraftIntent(fixture.expected.runningId).delivery).toBe('uncertain')
})
