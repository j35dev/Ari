import { expect, it } from 'vitest'
import {
  branchBelongsToSession,
  branchKey,
  branchSlug,
  orchestrationBranch,
} from './orchestration-branch'

const id = 'sess_c2825b69-d75a-415c-aef6-1deba05b3ded'

it('builds a branch from the title and a complete session identity digest', () => {
  expect(branchKey(id)).toBe('s_c73c05a0d7ac7c6182faf2d2f37bc41bf70bd5f9f7ceb8ee7228731d2d86ec2b')
  expect(branchSlug('Edit queued message')).toBe('edit-queued-message')
  expect(orchestrationBranch('Edit queued message', id)).toBe(
    'ari/edit-queued-message-s_c73c05a0d7ac7c6182faf2d2f37bc41bf70bd5f9f7ceb8ee7228731d2d86ec2b',
  )
  expect(orchestrationBranch('  ', id)).toBe(
    'ari/s_c73c05a0d7ac7c6182faf2d2f37bc41bf70bd5f9f7ceb8ee7228731d2d86ec2b',
  )
  expect(orchestrationBranch('Café parser!', 'child')).toBe(
    'ari/cafe-parser-s_ddc9e669194254cef019a29d3619a2c16592e5d52e1a81e98b01bd52319149a3',
  )
})

it('recognises the titled branch, a collision suffix, and the old id branch', () => {
  expect(
    branchBelongsToSession(
      'ari/edit-queued-message-s_c73c05a0d7ac7c6182faf2d2f37bc41bf70bd5f9f7ceb8ee7228731d2d86ec2b',
      id,
    ),
  ).toBe(true)
  expect(
    branchBelongsToSession(
      'ari/edit-queued-message-s_c73c05a0d7ac7c6182faf2d2f37bc41bf70bd5f9f7ceb8ee7228731d2d86ec2b-2',
      id,
    ),
  ).toBe(true)
  expect(branchBelongsToSession(`ari/j9bo5_5yipru/${id}`, id)).toBe(true)
  expect(branchBelongsToSession('ari/edit-queued-message-aaaaaaaa', id)).toBe(false)
  expect(branchBelongsToSession('main', id)).toBe(false)
  expect(branchBelongsToSession('ari/child', 'child')).toBe(true)
  expect(branchBelongsToSession('ari/edit-queued-message-c2825b69', id)).toBe(false)
})

it('does not share ownership between roots with the same timestamp prefix', () => {
  const one = 'sess_mabcd123a_aaaaaa'
  const two = 'sess_mabcd123a_bbbbbb'
  expect(branchKey(one)).not.toBe(branchKey(two))
  expect(branchBelongsToSession(orchestrationBranch('Work', two), one)).toBe(false)
  expect(branchBelongsToSession(`${orchestrationBranch('Work', two)}-2`, one)).toBe(false)
  expect(branchBelongsToSession('ari/work-mabcd123', one)).toBe(false)
})
