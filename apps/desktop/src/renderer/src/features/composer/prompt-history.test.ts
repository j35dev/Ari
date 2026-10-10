import { describe, expect, it } from 'vitest'
import { promptHistory, stepPromptHistory } from './prompt-history'

describe('promptHistory', () => {
  it('drops blanks and collapses back-to-back repeats but keeps later ones', () => {
    expect(promptHistory(['fix it', ' fix it ', '', 'run tests', 'fix it'])).toEqual([
      'fix it',
      'run tests',
      'fix it',
    ])
  })
})

describe('stepPromptHistory', () => {
  const history = ['first', 'second', 'third']

  it('walks older from the draft and stops at the oldest', () => {
    expect(stepPromptHistory(history, null, 'older')).toEqual({ index: 2, text: 'third' })
    expect(stepPromptHistory(history, 2, 'older')).toEqual({ index: 1, text: 'second' })
    expect(stepPromptHistory(history, 0, 'older')).toBeNull()
  })

  it('walks newer back to the empty draft and does nothing from it', () => {
    expect(stepPromptHistory(history, 1, 'newer')).toEqual({ index: 2, text: 'third' })
    expect(stepPromptHistory(history, 2, 'newer')).toEqual({ index: null, text: '' })
    expect(stepPromptHistory(history, null, 'newer')).toBeNull()
  })

  it('has nowhere to go without history', () => {
    expect(stepPromptHistory([], null, 'older')).toBeNull()
  })
})
