import { expect, it } from 'vitest'
import { exceedsPermission } from './common'

it('compares permission ceilings in both directions, including equality', () => {
  expect(exceedsPermission('full', 'ask')).toBe(true)
  expect(exceedsPermission('full', 'allow-edits')).toBe(true)
  expect(exceedsPermission('allow-edits', 'ask')).toBe(true)
  expect(exceedsPermission('ask', 'full')).toBe(false)
  expect(exceedsPermission('allow-edits', 'full')).toBe(false)
  expect(exceedsPermission('full', 'full')).toBe(false)
  expect(exceedsPermission('ask', 'ask')).toBe(false)
})
