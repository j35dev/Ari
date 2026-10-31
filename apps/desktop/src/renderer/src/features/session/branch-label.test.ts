import { expect, it } from 'vitest'
import { branchLabel } from './branch-label'

it('shows the title of an orchestration branch and leaves other names alone', () => {
  expect(branchLabel('ari/edit-queued-message-c2825b69')).toBe('edit-queued-message')
  expect(branchLabel('ari/edit-queued-message-c2825b69-2')).toBe('edit-queued-message')
  expect(branchLabel('ari/j9bo5_5yipru/sess_c2825b69-d75a-415c-aef6-1deba05b3ded')).toBe(
    'ari/j9bo5_5yipru/sess_c2825b69-d75a-415c-aef6-1deba05b3ded',
  )
  expect(branchLabel('main')).toBe('main')
})
