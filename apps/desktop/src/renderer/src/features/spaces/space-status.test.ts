import { describe, expect, it } from 'vitest'
import type { SessionActivityPhase } from '../session/session-activity'
import type { PaneNode } from '../split/split-layout'
import type { Space } from './spaces'
import { spaceStatus } from './space-status'

/** A row of leaves, one per session slot; null is a blank pane. */
function spaceWith(sessions: (string | null)[]): Space {
  let root: PaneNode = { kind: 'leaf', paneId: 'p0', sessionId: sessions[0] ?? null }
  for (let i = 1; i < sessions.length; i += 1) {
    root = {
      kind: 'split',
      nodeId: `s${String(i)}`,
      direction: 'row',
      ratio: 0.5,
      a: root,
      b: { kind: 'leaf', paneId: `p${String(i)}`, sessionId: sessions[i] ?? null },
    }
  }
  return {
    id: 'space-x',
    name: 'Space X',
    layout: { root, focusedPaneId: 'p0', zoomedPaneId: null },
  }
}

function phaseOf(
  phases: Record<string, SessionActivityPhase>,
): (id: string) => SessionActivityPhase | undefined {
  return (id) => phases[id]
}

describe('spaceStatus', () => {
  it('leaves a space with nothing notable unmarked', () => {
    expect(spaceStatus(spaceWith(['sA', null]), phaseOf({}))).toBeNull()
  })

  it('marks a working session as working', () => {
    expect(spaceStatus(spaceWith(['sA']), phaseOf({ sA: 'working' }))).toBe('working')
  })

  it('marks a paused, finished or failed session as needing attention', () => {
    for (const phase of ['paused', 'done', 'error'] as const) {
      expect(spaceStatus(spaceWith(['sA']), phaseOf({ sA: phase }))).toBe('attention')
    }
  })

  it('lets attention outrank work still in flight', () => {
    expect(spaceStatus(spaceWith(['sA', 'sB']), phaseOf({ sA: 'working', sB: 'done' }))).toBe(
      'attention',
    )
  })
})
