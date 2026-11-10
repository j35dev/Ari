import { expect, it } from 'vitest'
import { resolveLaunchEffort, taskEffort } from './launch-effort'

const options = ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id }))

it.each([
  ['Extract the list of names', 'low'],
  ['Fix a typo in the title', 'low'],
  ['Explain this function', 'medium'],
  ['Investigate and fix the regression with tests', 'high'],
  ['Design an architecture migration across services', 'xhigh'],
])('assesses %s as %s', (text, effort) => expect(taskEffort(text)).toBe(effort))

it('raises a saved low baseline for code work without raising every task to xhigh', () => {
  expect(resolveLaunchEffort({ options, baseline: 'low', text: 'Implement search' })).toMatchObject(
    { resolved: 'high', source: 'task' },
  )
  expect(
    resolveLaunchEffort({
      options,
      baseline: 'xhigh',
      baselineSource: 'inherited',
      text: 'Extract names',
    }),
  ).toMatchObject({ resolved: 'xhigh', source: 'inherited' })
  expect(
    resolveLaunchEffort({ options, requested: 'auto', baseline: 'xhigh', text: 'Extract names' }),
  ).toMatchObject({ resolved: 'low', source: 'task' })
})

it('honors explicit effort and refuses unsupported values instead of translating them silently', () => {
  expect(
    resolveLaunchEffort({ options, requested: 'low', text: 'Architecture migration' }),
  ).toMatchObject({ resolved: 'low', source: 'explicit' })
  expect(() => resolveLaunchEffort({ options, requested: 'ultra' })).toThrow('not supported')
  expect(resolveLaunchEffort({ options, requested: null })).toMatchObject({
    resolved: null,
    source: 'provider-default',
  })
})

it('uses only advertised IDs and makes support limitations clear', () => {
  const limited = resolveLaunchEffort({
    options: [{ id: 'low' }, { id: 'high' }],
    text: 'Architecture migration',
  })
  expect(limited.resolved).toBe('high')
  expect(limited.reason).toContain('supports no higher effort')
  expect(
    resolveLaunchEffort({ options: [{ id: 'extra-high' }], text: 'Architecture migration' })
      .resolved,
  ).toBe('extra-high')
  expect(resolveLaunchEffort({ options: [] })).toMatchObject({
    resolved: null,
    source: 'unsupported',
    supported: [],
  })
  expect(() => resolveLaunchEffort({ options: [], requested: 'high' })).toThrow('none advertised')
})
