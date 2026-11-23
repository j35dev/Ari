// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { project } from './model'
import {
  labScenario,
  liveCheckpoint,
  attentionCheckpoint,
  disconnectedCheckpoint,
} from './lab-fixture'
import { research } from './research'

describe('new streaming design fixture', () => {
  it('keeps every character across partial narration chunks', () => {
    const result = project(labScenario.events)
    expect(result.rows[0]).toMatchObject({
      text: 'I’m tracing the sidebar’s update path. I’ll follow the navigation projection, check its subscribers, and run the focused tests.',
    })
  })
  it('has two independent active commands at the working checkpoint', () => {
    const tools = [...project(labScenario.events.slice(0, liveCheckpoint)).tools.values()]
    expect(tools.filter((tool) => tool.status === 'running').map((tool) => tool.callId)).toEqual([
      'test-projection',
      'test-sidebar',
    ])
    expect(tools.filter((tool) => tool.category === 'read')).toHaveLength(3)
  })
  it('preserves a 132-line failure beside an actionable decision', () => {
    const result = project(labScenario.events.slice(0, attentionCheckpoint))
    expect(result.tools.get('navigation-review:test-projection')).toMatchObject({
      status: 'failed',
    })
    expect(result.tools.get('navigation-review:test-projection')?.output.split('\n')).toHaveLength(
      132,
    )
    expect(result.rows.at(-1)).toMatchObject({
      kind: 'decision',
      id: 'rerun',
      options: ['Allow once', 'Deny'],
    })
  })
  it('keeps the retry running when connection is lost', () => {
    const result = project(labScenario.events.slice(0, disconnectedCheckpoint))
    expect(result.connected).toBe(false)
    expect(result.tools.get('navigation-review:retry')?.status).toBe('running')
  })
  it('does not erase the failed attempt after the successful retry', () => {
    const result = project(labScenario.events)
    expect(result.settled).toBe(true)
    expect(result.tools.size).toBe(7)
    expect(result.tools.get('navigation-review:test-projection')?.status).toBe('failed')
    expect(result.tools.get('navigation-review:retry')?.status).toBe('completed')
    expect(project(labScenario.events.concat(labScenario.events))).toEqual(result)
  })
  it('labels reports and legacy screens separately from current documentation', () => {
    expect(research.some((source) => source.kind.startsWith('User report'))).toBe(true)
    expect(research.some((source) => source.kind.includes('earlier-version'))).toBe(true)
    expect(new Set(research.map((source) => source.product)).size).toBeGreaterThanOrEqual(6)
  })
})
