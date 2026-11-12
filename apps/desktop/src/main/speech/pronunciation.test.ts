// @vitest-environment node
import { expect, it } from 'vitest'
import {
  ARIA_LEXICON,
  lexiconWords,
  normalizeSpeech,
  normalizeCloudSpeech,
  numberWords,
  prepareKokoro,
} from './pronunciation'

it('ships names and technical initialisms with explicit phonemes', () => {
  expect(ARIA_LEXICON.ari).toBe('ˈ ɑ ɹ i')
  expect(ARIA_LEXICON.aria).toBe('ˈ ɑ ɹ i ə')
  for (const name of ['codex', 'grok', 'opencode', 'pi', 'pr', 'acp', 'cli'])
    expect(ARIA_LEXICON).toHaveProperty(name)
})
it('normalizes numbers without silently losing digits', () => {
  expect(normalizeSpeech('About $123.4, 42% and 1,234 tests.')).toBe(
    'About one hundred twenty three dollars, forty two percent and one thousand two hundred thirty four tests.',
  )
  expect(numberWords(-12)).toBe('minus twelve')
  expect(normalizeSpeech('PR ACP CLI https://github.com/j35dev/Ari')).toBe(
    'pr acp cli github dot com',
  )
})
it('covers every source word including unknown words with a spell-out fallback', () => {
  const words = lexiconWords(
    'the ð ə\nfix f ɪ k s\n' +
      Object.keys(ARIA_LEXICON)
        .map((x) => `${x} x`)
        .join('\n') +
      '\n' +
      'abcdefghijklmnopqrstuvwxyz'
        .split('')
        .map((x) => `${x} x`)
        .join('\n'),
  )
  const result = prepareKokoro('The Quuxwidget fix Ari Codex Grok Pi.', words)
  expect(result.words).toBe(7)
  expect(result.spelled).toEqual(['Quuxwidget'])
  expect(result.text).toContain('q u u x w i d g e t')
  expect(prepareKokoro('details', words).spelled).toEqual([])
  for (const word of result.text.match(/[a-z]+/g) ?? [])
    expect(words.has(word), `missing word: ${word}`).toBe(true)
})
it('fails rather than passing unsupported words to dictionary-only synthesis', () => {
  expect(() => prepareKokoro('Quuxwidget', new Set())).toThrow('dictionary is incomplete')
  expect(() => prepareKokoro('日本語', new Set())).toThrow('cannot pronounce')
})

it('rounds decimals usefully and says cloud initialisms and Ari names naturally', () => {
  expect(normalizeSpeech('0.67 real time, $0.04 and 1.234 seconds.')).toBe(
    'zero point six seven real time, four cents and one point two seconds.',
  )
  expect(normalizeCloudSpeech('Ari and Aria checked the PR and CLI.')).toBe(
    'Ah ree and Ah ree uh checked the P R and C L I.',
  )
})
