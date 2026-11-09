import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropDraftIntentMemory,
  readSessionDraftIntent,
  RECOVERY_STORAGE_KEY,
  updateSessionDraftIntent,
} from './draft-recovery-store'

describe('draft recovery persistence after an incomplete read', () => {
  beforeEach(() => {
    dropDraftIntentMemory()
    localStorage.clear()
  })

  afterEach(() => vi.restoreAllMocks())

  it('retains stored recoveries when initial reads fail and later writes are available', () => {
    const original = JSON.stringify({
      version: 1,
      sessions: {
        s1: { images: [], picks: [], recoveries: [], delivery: 'uncertain' },
      },
    })
    localStorage.setItem(RECOVERY_STORAGE_KEY, original)
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('temporary read failure')
    })
    expect(readSessionDraftIntent('s1').reattachRequired).toBe(true)
    updateSessionDraftIntent('s1', (state) => ({ ...state, reattachRequired: false }))
    expect(readSessionDraftIntent('s1').storageIssue).toBe(true)
    read.mockRestore()

    // Visiting another session must not turn the incomplete cache into a full
    // replacement of the previously stored session's uncertain-send marker.
    readSessionDraftIntent('s2')
    updateSessionDraftIntent('s2', (state) => ({ ...state, delivery: 'uncertain' }))
    expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(original)
    updateSessionDraftIntent('', (state) => state)
    expect(readSessionDraftIntent('s1').storageIssue).toBe(true)

    dropDraftIntentMemory()
    expect(readSessionDraftIntent('s1').delivery).toBe('uncertain')
  })
})
