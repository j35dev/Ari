import { expect, it } from 'vitest'
import {
  branchBelongsToSession,
  branchKey,
  branchSlug,
  orchestrationBranch,
} from './orchestration-branch'

const id = 'sess_c2825b69-d75a-415c-aef6-1deba05b3ded'

it('builds a branch from the title and a short session key', () => {
  expect(branchKey(id)).toBe('c2825b69')
  expect(branchSlug('Edit queued message')).toBe('edit-queued-message')
  expect(orchestrationBranch('Edit queued message', id)).toBe('ari/edit-queued-message-c2825b69')
  expect(orchestrationBranch('  ', id)).toBe('ari/c2825b69')
  expect(orchestrationBranch('Café parser!', 'child')).toBe('ari/cafe-parser-child')
})

it('recognises the titled branch, a collision suffix, and the old id branch', () => {
  expect(branchBelongsToSession('ari/edit-queued-message-c2825b69', id)).toBe(true)
  expect(branchBelongsToSession('ari/edit-queued-message-c2825b69-2', id)).toBe(true)
  expect(branchBelongsToSession(`ari/j9bo5_5yipru/${id}`, id)).toBe(true)
  expect(branchBelongsToSession('ari/edit-queued-message-aaaaaaaa', id)).toBe(false)
  expect(branchBelongsToSession('main', id)).toBe(false)
  expect(branchBelongsToSession('ari/child', 'child')).toBe(true)
})
