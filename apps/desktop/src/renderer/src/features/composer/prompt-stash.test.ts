import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadStash,
  persistStash,
  stashPrompt,
  STASH_LIMIT,
  type StashEntry,
} from './prompt-stash'

const entry = (text: string, savedAt = 1000): StashEntry => ({ text, savedAt })

describe('stashPrompt', () => {
  it('prepends newest first and caps the list', () => {
    let stash: StashEntry[] = []
    for (let i = 0; i < STASH_LIMIT + 5; i++) {
      stash = stashPrompt(`prompt ${i}`, stash)
    }
    expect(stash).toHaveLength(STASH_LIMIT)
    expect(stash[0]?.text).toBe(`prompt ${STASH_LIMIT + 4}`)
  })

  it('collapses duplicate prompts onto the existing entry', () => {
    let stash = stashPrompt('first', [], 1000)
    stash = stashPrompt('second', stash, 2000)
    stash = stashPrompt('first', stash, 3000)
    expect(stash.map((e) => e.text)).toEqual(['first', 'second'])
    expect(stash[0]?.savedAt).toBe(3000)
  })

  it('ignores blank input', () => {
    expect(stashPrompt('   ', [entry('kept')])).toEqual([entry('kept')])
  })
})

describe('loadStash / persistStash', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips through storage', () => {
    const store = localStorage
    persistStash([entry('hello prompt', 42)], store)
    expect(loadStash(store)).toEqual([entry('hello prompt', 42)])
  })

  it('returns empty for corrupt payloads instead of throwing', () => {
    localStorage.setItem('ari.prompt-stash', '{not json')
    expect(loadStash()).toEqual([])
    localStorage.setItem('ari.prompt-stash', '[{"text":123}]')
    expect(loadStash()).toEqual([])
  })
})
