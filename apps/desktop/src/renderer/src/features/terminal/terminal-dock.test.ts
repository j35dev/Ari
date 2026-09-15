import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateTerminalTab,
  closeTerminalTab,
  openTerminalTab,
  resetTerminalDock,
  subscribeTerminalDock,
  terminalDockState,
  uniqueTabTitle,
  TERMINAL_DOCK_STORAGE_KEY,
} from './terminal-dock'

describe('terminal-dock', () => {
  beforeEach(() => {
    resetTerminalDock()
  })

  it('starts empty', () => {
    expect(terminalDockState()).toEqual({ tabs: [], activeId: null })
  })

  it('opens tabs, focuses the newest, and mints unique ids', () => {
    const first = openTerminalTab({ title: 'Ari Terminal', cwd: '/repo' })
    const second = openTerminalTab({ title: 'my-app: dev', cwd: '/repo', command: 'pnpm dev' })

    const { tabs, activeId } = terminalDockState()
    expect(tabs.map((tab) => tab.id)).toEqual([first, second])
    expect(first).not.toBe(second)
    expect(activeId).toBe(second)
    expect(tabs[1]).toMatchObject({ title: 'my-app: dev', cwd: '/repo', command: 'pnpm dev' })
  })

  it('dedupes repeated titles instead of showing two identical tabs', () => {
    openTerminalTab({ title: 'Ari Terminal', cwd: '/repo' })
    openTerminalTab({ title: 'Ari Terminal', cwd: '/repo' })
    openTerminalTab({ title: 'Ari Terminal', cwd: '/repo' })

    expect(terminalDockState().tabs.map((tab) => tab.title)).toEqual([
      'Ari Terminal',
      'Ari Terminal 2',
      'Ari Terminal 3',
    ])
  })

  it('closing the focused tab falls back to its left neighbour', () => {
    const first = openTerminalTab({ title: 'one', cwd: '/repo' })
    const second = openTerminalTab({ title: 'two', cwd: '/repo' })

    closeTerminalTab(second)

    expect(terminalDockState().activeId).toBe(first)
    expect(terminalDockState().tabs).toHaveLength(1)
  })

  it('closing the leftmost focused tab falls forward, and the last one clears focus', () => {
    const first = openTerminalTab({ title: 'one', cwd: '/repo' })
    const second = openTerminalTab({ title: 'two', cwd: '/repo' })
    activateTerminalTab(first)

    closeTerminalTab(first)
    expect(terminalDockState().activeId).toBe(second)

    closeTerminalTab(second)
    expect(terminalDockState()).toEqual({ tabs: [], activeId: null })
  })

  it('closing a background tab leaves focus alone; unknown ids are no-ops', () => {
    const first = openTerminalTab({ title: 'one', cwd: '/repo' })
    const second = openTerminalTab({ title: 'two', cwd: '/repo' })

    closeTerminalTab(first)
    expect(terminalDockState().activeId).toBe(second)

    const before = terminalDockState()
    closeTerminalTab('term_nope')
    activateTerminalTab('term_nope')
    expect(terminalDockState()).toBe(before)
  })

  it('notifies subscribers on every mutation and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalDock(listener)

    const id = openTerminalTab({ title: 'one', cwd: '/repo' })
    openTerminalTab({ title: 'two', cwd: '/repo' })
    activateTerminalTab(id)
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    closeTerminalTab(id)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('keeps snapshots referentially stable so React can skip renders', () => {
    openTerminalTab({ title: 'one', cwd: '/repo' })
    expect(terminalDockState()).toBe(terminalDockState())
  })

  it('exposes the title dedupe rule on its own', () => {
    const tabs = [{ id: 'a', title: 'sh', cwd: '/repo' }]
    expect(uniqueTabTitle('sh', tabs)).toBe('sh 2')
    expect(uniqueTabTitle('zsh', tabs)).toBe('zsh')
  })

  it('writes tabs to storage so a reload can find them again', () => {
    const id = openTerminalTab({ title: 'my-app: dev', cwd: '/repo', command: 'pnpm dev' })

    const stored: unknown = JSON.parse(localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY) ?? 'null')
    expect(stored).toEqual({
      tabs: [{ id, title: 'my-app: dev', cwd: '/repo' }],
      activeId: id,
    })
  })

  it('restores stored tabs on load, without replaying one-shot commands', async () => {
    localStorage.setItem(
      TERMINAL_DOCK_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { id: 'term_1_abc', title: 'Ari Terminal', cwd: '/repo' },
          { id: 'term_2_def', title: 'my-app: dev', cwd: '/repo', command: 'pnpm dev' },
        ],
        activeId: 'term_2_def',
      }),
    )
    vi.resetModules()

    const reloaded = await import('./terminal-dock')
    const { tabs, activeId } = reloaded.terminalDockState()

    expect(tabs).toEqual([
      { id: 'term_1_abc', title: 'Ari Terminal', cwd: '/repo' },
      { id: 'term_2_def', title: 'my-app: dev', cwd: '/repo' },
    ])
    expect(activeId).toBe('term_2_def')
  })

  it('ignores unusable stored state rather than starting broken', async () => {
    for (const raw of ['not json', '{}', '{"tabs":[{"id":5}]}', 'null']) {
      localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, raw)
      vi.resetModules()
      const reloaded = await import('./terminal-dock')
      expect(reloaded.terminalDockState()).toEqual({ tabs: [], activeId: null })
    }
  })

  it('falls back to the first tab when the stored active id is gone', async () => {
    localStorage.setItem(
      TERMINAL_DOCK_STORAGE_KEY,
      JSON.stringify({
        tabs: [{ id: 'term_1_abc', title: 'Ari Terminal', cwd: '/repo' }],
        activeId: 'term_9_zzz',
      }),
    )
    vi.resetModules()

    const reloaded = await import('./terminal-dock')
    expect(reloaded.terminalDockState().activeId).toBe('term_1_abc')
  })
})
