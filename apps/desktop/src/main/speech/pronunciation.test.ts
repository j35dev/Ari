// @vitest-environment node
import { expect, it } from 'vitest'
import {
  ARIA_LEXICON,
  expandLexicon,
  inflections,
  lexiconWords,
  nearWord,
  splitIntoWords,
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
  expect(() => prepareKokoro('日本語', new Set())).toThrow('cannot read this language')
})

it('reads the actual English reply with smart punctuation instead of treating it as another language', () => {
  const words = lexiconWords(
    'abcdefghijklmnopqrstuvwxyz'
      .split('')
      .map((word) => `${word} x`)
      .join('\n'),
  )
  const reply = 'No projects yet — none in the workspace and none running. Want to create one?'
  const result = prepareKokoro(reply, words)
  expect(result.words).toBe(14)
  expect([...result.text].every((character) => character.codePointAt(0)! <= 127)).toBe(true)
  expect(result.spelled).toContain('projects')
  expect(normalizeSpeech('“It’s ready…” Use Ctrl–Alt–V; 3–5 minutes → done.')).toBe(
    '"It\'s ready..." Use Ctrl-Alt-V; three to five minutes to done.',
  )
})

it('rounds decimals usefully and says cloud initialisms and Ari names naturally', () => {
  expect(normalizeSpeech('0.67 real time, $0.04 and 1.234 seconds.')).toBe(
    'zero point six seven real time, four cents and one point two seconds.',
  )
  expect(normalizeCloudSpeech('Ari and Aria checked the PR and CLI.')).toBe(
    'Ah ree and Ah ree uh checked the P R and C L I.',
  )
})

it('speaks emphasized English and common status words naturally while retaining genuine initials', () => {
  const words = lexiconWords(
    'ready ɹ ɛ d i\ndone d ʌ n\napproved ə p ɹ u v d\nthe ð ə\nwork w ɜ ɹ k\nis ɪ z\nand æ n d\n' +
      Object.entries(ARIA_LEXICON)
        .map(([word, phonemes]) => `${word} ${phonemes}`)
        .join('\n'),
  )
  const prepared = prepareKokoro(
    'READY. The work is APPROVED, completed, reviewed and verified. DONE.',
    words,
  )
  expect(prepared.spelled).toEqual([])
  expect(prepared.text).toBe('ready. the work is approved, completed, reviewed and verified. done.')
  expect(normalizeSpeech('READY DONE HELLO APPROVED')).toBe('READY DONE HELLO APPROVED')
  expect(normalizeSpeech('API CPU GPU PR ACP CLI')).toBe('A P I C P U G P U pr acp cli')
})

it('derives the regular forms the dictionary leaves out, matching the hand-written ones', () => {
  // The same phonemes the lexicon above had to list by hand before this existed.
  const forms = (word: string, phonemes: string) => new Map(inflections(word, phonemes))
  expect(forms('complete', 'k ə m p l ˈ i t').get('completed')).toBe(ARIA_LEXICON.completed)
  expect(forms('detail', 'd ə t ˈ A l').get('details')).toBe(ARIA_LEXICON.details)
  expect(forms('review', 'ɹ ə v j ˈ u').get('reviewed')).toBe(ARIA_LEXICON.reviewed)
  expect(forms('agent', 'ˈ A ʤ ᵊ n t').get('agents')).toBe('ˈ A ʤ ᵊ n t s')
  expect(forms('box', 'b ˈ ɑ k s').get('boxes')).toBe('b ˈ ɑ k s ᵻ z')
  expect(forms('push', 'p ˈ ʊ ʃ').get('pushed')).toBe('p ˈ ʊ ʃ t')
  expect(forms('delete', 'd ə l ˈ i t').get('deleting')).toBe('d ə l ˈ i t ɪ ŋ')
  expect(forms('stop', 's t ˈ ɑ p').get('stopped')).toBe('s t ˈ ɑ p t')
  expect(forms('try', 't ɹ ˈ I').get('tries')).toBe('t ɹ ˈ I z')

  const extra = expandLexicon('agent ˈ A ʤ ᵊ n t\nagents x\nwalked w ˈ ɔ k t\nan æ n')
  // Listed forms are left alone, inflections get none of their own, short words are skipped.
  expect(extra).toContain('agenting ')
  expect(extra).not.toMatch(/^agents /m)
  expect(extra).not.toContain('walkeds')
  expect(extra).not.toMatch(/^ans /m)
})
it('says compounds, possessives and near-miss names as words instead of spelling them', () => {
  const words = lexiconWords(
    'work x\ntree x\nfront x\nend x\ncollect x\nthe x\nari x\nin x\n' +
      'abcdefghijklmnopqrstuvwxyz'
        .split('')
        .map((letter) => `${letter} x`)
        .join('\n'),
  )
  expect(splitIntoWords('worktree', words)).toEqual(['work', 'tree'])
  expect(splitIntoWords('zzqx', words)).toBeNull()
  expect(nearWord('kollect', words)).toBe('collect')
  expect(nearWord('zustand', words)).toBeNull()
  const prepared = prepareKokoro("The worktree in Ari's Kollect frontend.", words)
  expect(prepared.text).toBe('the work tree in ari collect front end.')
  expect(prepared.spelled).toEqual([])
  // A word with no reading at all is still spelled, and reported.
  expect(prepareKokoro('Zustand', words).spelled).toEqual(['Zustand'])
})
