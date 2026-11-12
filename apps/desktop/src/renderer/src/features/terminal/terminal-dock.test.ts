import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateTerminalTab,
  bindRemoteTerminalTab,
  closeTerminalTab,
  forgetMachineTerminals,
  openTerminalTab,
  resetTerminalDock,
  subscribeTerminalDock,
  terminalDockState,
  terminalTabsForOwner,
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

  it('keeps local, host and session rails separate even when paths and host IDs collide', () => {
    const a = { kind: 'remote' as const, machineId: 'machine-a', sessionId: 'sess_same' }
    const b = { kind: 'remote' as const, machineId: 'machine-b', sessionId: 'sess_same' }
    const other = { ...a, sessionId: 'sess_other' }
    const local = openTerminalTab({ title: 'shell', cwd: '/repo' })
    const remote = openTerminalTab({ title: 'shell', cwd: '/repo', owner: a })
    openTerminalTab({ title: 'shell', cwd: '/repo', owner: b })
    openTerminalTab({ title: 'shell', cwd: '/repo', owner: other })
    expect(terminalTabsForOwner({ kind: 'local' }).map((tab) => tab.id)).toEqual([local])
    expect(terminalTabsForOwner(a).map((tab) => tab.id)).toEqual([remote])
    expect(remote).toMatch(/^rterm_/)
  })

  it('binds a remote shell once and refuses adoption by a different host or session', () => {
    const owner = { kind: 'remote' as const, machineId: 'machine-a', sessionId: 'sess_a' }
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner })
    bindRemoteTerminalTab(id, owner, 'host-term')
    const before = terminalDockState()
    bindRemoteTerminalTab(id, owner, 'host-term')
    expect(terminalDockState()).toBe(before)
    for (const foreign of [
      { ...owner, machineId: 'machine-b' },
      { ...owner, sessionId: 'sess_b' },
    ])
      expect(() => bindRemoteTerminalTab(id, foreign, 'host-term')).toThrow('another host')
    expect(() => bindRemoteTerminalTab(id, owner, 'different-term')).toThrow('another host')
    expect(() => bindRemoteTerminalTab(id, owner, '')).toThrow('another host')
    expect(terminalDockState()).toBe(before)
  })

  it('restores exact remote ownership and confirmed host ID without replaying input', async () => {
    const owner = { kind: 'remote' as const, machineId: 'machine-a', sessionId: 'sess_a' }
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner, command: 'dangerous-once' })
    bindRemoteTerminalTab(id, owner, 'host-term')
    vi.resetModules()
    const reloaded = await import('./terminal-dock')
    expect(reloaded.terminalDockState().tabs).toEqual([
      { id, title: 'shell', cwd: '.', owner, hostTerminalId: 'host-term', creationAttempted: true },
    ])
  })

  it('never restores a damaged remote binding as a local shell', async () => {
    localStorage.setItem(
      TERMINAL_DOCK_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          { id: 'term_legacy', title: 'local', cwd: '/repo' },
          { id: 'rterm_missing', title: 'remote', cwd: '/repo' },
          {
            id: 'term_bad',
            title: 'remote',
            cwd: '/repo',
            owner: { kind: 'remote', machineId: 'a' },
          },
          { id: 'term_unknown', title: 'remote', cwd: '/repo', owner: { kind: 'other' } },
          { id: 'term_misbound', title: 'local', cwd: '/repo', hostTerminalId: 'host-term' },
        ],
        activeId: 'rterm_missing',
      }),
    )
    vi.resetModules()
    const reloaded = await import('./terminal-dock')
    expect(reloaded.terminalDockState()).toEqual({
      tabs: [{ id: 'term_legacy', title: 'local', cwd: '/repo' }],
      activeId: 'term_legacy',
    })
  })

  it('revocation removes only the affected host tabs, preserving other hosts and local shells', () => {
    const local = openTerminalTab({ title: 'local', cwd: '/repo' })
    const b = openTerminalTab({
      title: 'b',
      cwd: '.',
      owner: { kind: 'remote', machineId: 'b', sessionId: 's' },
    })
    openTerminalTab({
      title: 'a',
      cwd: '.',
      owner: { kind: 'remote', machineId: 'a', sessionId: 's' },
    })
    forgetMachineTerminals('a')
    expect(terminalDockState().tabs.map((tab) => tab.id)).toEqual([local, b])
    expect(terminalDockState().activeId).toBe(local)
  })
})
