import { beforeEach, describe, expect, it } from 'vitest'
import { activePaneOf, leaves } from '../split/split-layout'
import {
  arrangeTerminalPanes,
  parseTerminalWorkspace,
  serializeTerminalWorkspace,
  terminalWorkspaceActions as actions,
  terminalWorkspaceSnapshot,
} from './terminal-workspace-state'

beforeEach(() => {
  actions.reset()
  localStorage.clear()
})

describe('native terminal task ownership', () => {
  it('keeps task layouts and terminal identities through a view switch and restore', () => {
    const task = actions.createTask('project', 'D:\\Project', 'Review')
    actions.attach(task.id, 'term_claude')
    const firstPane = activePaneOf(terminalWorkspaceSnapshot().tasks[0]!.layout)
    actions.attach(task.id, 'term_codex', firstPane, 'right')
    const before = terminalWorkspaceSnapshot().tasks[0]!
    actions.setView('sessions')
    actions.setView('terminals', 'project')
    expect(terminalWorkspaceSnapshot().tasks[0]!.layout).toBe(before.layout)
    const saved = parseTerminalWorkspace(serializeTerminalWorkspace(terminalWorkspaceSnapshot()))
    expect(saved?.view).toBe('terminals')
    expect(leaves(saved!.tasks[0]!.layout.root).map((pane) => pane.terminalId)).toEqual([
      'term_claude',
      'term_codex',
    ])
  })

  it('parks presentation independently from process metadata', () => {
    const task = actions.createTask('project', '/repo', 'Build')
    actions.attach(task.id, 'term_build')
    actions.closeTask(task.id)
    expect(terminalWorkspaceSnapshot().activeTaskId).toBeNull()
    expect(terminalWorkspaceSnapshot().tasks[0]?.closed).toBe(true)
    expect(leaves(terminalWorkspaceSnapshot().tasks[0]!.layout.root)[0]?.terminalId).toBe(
      'term_build',
    )
    actions.selectTask(task.id)
    expect(terminalWorkspaceSnapshot().tasks[0]?.closed).toBe(false)
    expect(terminalWorkspaceSnapshot().activeTaskId).toBe(task.id)
  })

  it('rearranges geometry without changing terminal or pane identities', () => {
    const task = actions.createTask('project', '/repo', 'Tools')
    actions.attach(task.id, 'term_a')
    actions.attach(
      task.id,
      'term_b',
      activePaneOf(terminalWorkspaceSnapshot().tasks[0]!.layout),
      'right',
    )
    actions.attach(
      task.id,
      'term_c',
      activePaneOf(terminalWorkspaceSnapshot().tasks[0]!.layout),
      'below',
    )
    const layout = terminalWorkspaceSnapshot().tasks[0]!.layout
    const samePanes = leaves(layout.root)
      .map((pane) => [pane.paneId, pane.terminalId])
      .sort()
    for (const arrangement of ['grid', 'columns'] as const)
      expect(
        leaves(arrangeTerminalPanes(layout, arrangement).root)
          .map((pane) => [pane.paneId, pane.terminalId])
          .sort(),
      ).toEqual(samePanes)
  })

  it('ignores focus on the already-active pane instead of causing a render loop', () => {
    const task = actions.createTask('project', '/repo', 'Tools')
    const before = terminalWorkspaceSnapshot()
    actions.focus(task.id, activePaneOf(task.layout))
    expect(terminalWorkspaceSnapshot()).toBe(before)
  })

  it('keeps the snapshot stable when selecting the current workspace view', () => {
    const before = terminalWorkspaceSnapshot()
    actions.setView('sessions')
    expect(terminalWorkspaceSnapshot()).toBe(before)
  })

  it('refuses duplicate terminal references and damaged persisted layouts', () => {
    const one = actions.createTask('project', '/repo', 'One')
    const two = actions.createTask('project', '/repo', 'Two')
    actions.attach(one.id, 'term_same')
    actions.attach(two.id, 'term_same')
    expect(leaves(terminalWorkspaceSnapshot().tasks[1]!.layout.root)[0]?.terminalId).toBeUndefined()
    const damaged = JSON.parse(serializeTerminalWorkspace(terminalWorkspaceSnapshot())) as {
      tasks: { layout: string }[]
    }
    const second = JSON.parse(damaged.tasks[1]!.layout) as { root: { terminalId?: string } }
    second.root.terminalId = 'term_same'
    damaged.tasks[1]!.layout = JSON.stringify(second)
    expect(parseTerminalWorkspace(JSON.stringify(damaged))).toBeNull()
    expect(parseTerminalWorkspace('{"version":999,"tasks":[]}')).toBeNull()
    expect(parseTerminalWorkspace('bad json')).toBeNull()
  })
})
