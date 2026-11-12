import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingNativeWords } from './aria-voice-diagnostics.mjs'

test('rejects the exact missing-word warning found in the original spike', () => {
  assert.equal(missingNativeWords("TokenizeFromLexiconStr:747 OOV word skipped: 'details'"), true)
  assert.equal(missingNativeWords("OOV word skipped: 'Ari'"), true)
})
test('rejects other native missing-word diagnostics', () => {
  for (const line of [
    'Skipped unknown word Quuxwidget',
    'word not found: PR',
    'missing from lexicon: CLI',
  ])
    assert.equal(missingNativeWords(line), true)
})
test('accepts successful native inference', () => {
  assert.equal(missingNativeWords(''), false)
  assert.equal(
    missingNativeWords('Model initialized. Language is determined by the lexicon files.'),
    false,
  )
})
