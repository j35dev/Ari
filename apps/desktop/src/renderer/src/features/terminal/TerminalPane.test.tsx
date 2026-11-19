import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { applyAppearance } from '../../lib/appearance'
import { TerminalPane } from './TerminalPane'
import { resetTerminalRuntimes, terminalStatus } from './terminal-runtime'
import { openTerminalTab, resetTerminalDock } from './terminal-dock'
import { DEFAULT_TERMINAL_PREFERENCES, setTerminalPreferences } from './terminal-preferences'
import { TerminalWorkspaceGrid } from './TerminalWorkspaceGrid'
import {
  terminalWorkspaceActions as actions,
  terminalWorkspaceSnapshot,
} from './terminal-workspace-state'

const {
  ctorOptions,
  liveOptions,
  invokeFn,
  writelnFn,
  focusFn,
  buffers,
  scrollListeners,
  parsedListeners,
  resizeListeners,
} = vi.hoisted(() => ({
  ctorOptions: [] as Record<string, unknown>[],
  liveOptions: [] as Record<string, unknown>[],
  invokeFn: vi.fn(),
  writelnFn: vi.fn(),
  focusFn: vi.fn(),
  buffers: [] as { active: { type: 'normal' | 'alternate'; baseY: number; viewportY: number } }[],
  scrollListeners: new Set<() => void>(),
  parsedListeners: new Set<() => void>(),
  resizeListeners: new Set<() => void>(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    buffer = { active: { type: 'normal' as 'normal' | 'alternate', baseY: 0, viewportY: 0 } }
    constructor(options: Record<string, unknown>) {
      ctorOptions.push(options)
      this.options = { ...options }
      liveOptions.push(this.options)
      buffers.push(this.buffer)
    }
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(data: string): void {
      writelnFn(data)
    }
    focus(): void {
      focusFn()
    }
    scrollToBottom(): void {
      this.buffer.active.viewportY = this.buffer.active.baseY
      for (const listener of scrollListeners) listener()
    }
    dispose(): void {}
    getSelection(): string {
      return ''
    }
    paste(): void {}
    input(): void {}
    attachCustomKeyEventHandler(): void {}
    onSelectionChange(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    onScroll(listener: () => void): { dispose: () => void } {
      scrollListeners.add(listener)
      return { dispose: () => scrollListeners.delete(listener) }
    }
    onWriteParsed(listener: () => void): { dispose: () => void } {
      parsedListeners.add(listener)
      return { dispose: () => parsedListeners.delete(listener) }
    }
    onResize(listener: () => void): { dispose: () => void } {
      resizeListeners.add(listener)
      return { dispose: () => resizeListeners.delete(listener) }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
  },
}))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke: invokeFn, subscribe: vi.fn(() => () => undefined) },
}))

function mount(): Record<string, unknown> {
  render(<TerminalPane terminalId="term_1" cwd="/repo" active />)
  const options = ctorOptions[0]
  if (options === undefined) throw new Error('Terminal was never constructed')
  return options
}

describe('TerminalPane', () => {
  afterEach(() => {
    resetTerminalRuntimes()
    resetTerminalDock()
    actions.reset()
    applyAppearance(defaultSettings.appearance)
  })
  beforeEach(() => {
    applyAppearance(defaultSettings.appearance)
    resetTerminalRuntimes()
    setTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES)
    ctorOptions.length = 0
    liveOptions.length = 0
    invokeFn.mockReset()
    invokeFn.mockResolvedValue(undefined)
    writelnFn.mockClear()
    focusFn.mockClear()
    buffers.length = 0
  })

  it('hands xterm a concrete font stack, never a CSS variable', () => {
    const fontFamily = String(mount()['fontFamily'])

    // xterm measures the character cell by assigning `ctx.font` on a canvas,
    // where `var(...)` is rejected outright — the grid would silently end up
    // measured against 10px sans-serif while the rows render in the real font.
    expect(fontFamily).not.toContain('var(')
    expect(fontFamily).toMatch(/monospace$/)
  })

  it('refuses a remote UI terminal ID before local create, resize, subscription or input', () => {
    const onError = vi.fn()
    render(<TerminalPane terminalId="rterm_1_remote" cwd="/remote" active onError={onError} />)
    expect(invokeFn).not.toHaveBeenCalled()
    expect(ctorOptions).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith('Reconnect this terminal to its owning machine.')
  })

  it('gives rows room to breathe at a legible size', () => {
    const options = mount()

    expect(options['fontSize']).toBe(14)
    expect(options['lineHeight']).toBeGreaterThan(1)
  })

  it('updates an open terminal font while chat sizing leaves its grid unchanged', async () => {
    mount()
    applyAppearance({ ...defaultSettings.appearance, codeFont: 'jetbrains-mono', fontSize: 18 })
    await vi.waitFor(() => {
      expect(liveOptions[0]?.['fontFamily']).toContain('JetBrains Mono Variable')
      expect(liveOptions[0]?.['fontSize']).toBe(14)
    })
    expect(ctorOptions).toHaveLength(1)
    expect(invokeFn.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(1)
  })

  it('spawns the pty for its own id in the given cwd', () => {
    mount()

    expect(invokeFn).toHaveBeenCalledWith('terminal.create', { id: 'term_1', cwd: '/repo' })
  })

  it('reuses the same terminal and sends one launch request when a pane moves', () => {
    const id = openTerminalTab({ title: 'Claude', cwd: '/repo' })
    const first = render(
      <TerminalPane terminalId={id} cwd="/repo" initialCommand="claude" active />,
    )
    first.unmount()
    render(<TerminalPane terminalId={id} cwd="/repo" initialCommand="claude" active />)
    expect(ctorOptions).toHaveLength(1)
    expect(invokeFn.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(1)
    expect(invokeFn).toHaveBeenCalledWith('terminal.create', {
      id,
      cwd: '/repo',
      initialCommand: 'claude',
    })
    expect(invokeFn.mock.calls.filter(([method]) => method === 'terminal.write')).toHaveLength(0)
  })

  it('attaches to a host-created login without restarting or repeating it', () => {
    const { unmount } = render(
      <TerminalPane
        terminalId="setup_1"
        cwd="/home/person"
        attachOnly
        active
        initialCommand="must-not-run"
      />,
    )
    expect(invokeFn).not.toHaveBeenCalledWith('terminal.create', expect.anything())
    expect(invokeFn).not.toHaveBeenCalledWith('terminal.write', expect.anything())
    expect(ctorOptions).toHaveLength(1)
    unmount()
  })

  it('clips the xterm host so a stacked pane cannot paint over its neighbour', () => {
    const { container } = render(<TerminalPane terminalId="term_1" cwd="/repo" active />)
    const host = container.firstElementChild
    expect(host?.className).toMatch(/overflow-hidden/)
    expect(host?.className).toMatch(/min-h-0/)
  })

  it('stays idle until a cwd is known', () => {
    render(<TerminalPane terminalId="term_2" cwd={null} active={false} />)

    expect(ctorOptions).toHaveLength(0)
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it('names a rejected create in the pane and reports it for retry', async () => {
    invokeFn.mockRejectedValueOnce(new Error('terminal backend unavailable'))
    const onError = vi.fn()
    render(<TerminalPane terminalId="term_3" cwd="/repo" active onError={onError} />)

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('terminal backend unavailable'))
    expect(writelnFn).toHaveBeenCalledOnce()
    expect(String(writelnFn.mock.calls[0]?.[0])).toContain('terminal backend unavailable')
  })

  async function mountWorkspace(): Promise<void> {
    invokeFn.mockImplementation(async (method: string) =>
      method === 'terminal.info' ? { cwd: '/repo', exited: false, exitCode: null } : undefined,
    )
    const task = actions.createTask('project', '/repo', 'Shell')
    const id = openTerminalTab({ title: 'Shell', cwd: '/repo', workspaceTaskId: task.id })
    actions.attach(task.id, id)
    render(
      <TerminalWorkspaceGrid
        task={terminalWorkspaceSnapshot().tasks[0]!}
        tabs={[{ id, title: 'Shell', cwd: '/repo', workspaceTaskId: task.id }]}
        active
        pending={new Set()}
        errors={{}}
        searchTarget={null}
        onSearch={vi.fn()}
        onLaunch={vi.fn()}
        onRestart={vi.fn()}
        onStop={vi.fn()}
      />,
    )
    await waitFor(() => expect(terminalStatus(id).state).toBe('running'))
  }

  it('shows the scroll button only away from the bottom and returns focus to terminal input', async () => {
    await mountWorkspace()
    expect(
      screen.queryByRole('button', { name: 'Scroll terminal to bottom' }),
    ).not.toBeInTheDocument()
    act(() => {
      buffers[0]!.active.baseY = 40
      buffers[0]!.active.viewportY = 10
      for (const listener of scrollListeners) listener()
    })
    focusFn.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Scroll terminal to bottom' }))
    expect(buffers[0]!.active.viewportY).toBe(40)
    expect(
      screen.queryByRole('button', { name: 'Scroll terminal to bottom' }),
    ).not.toBeInTheDocument()
    expect(focusFn).toHaveBeenCalledOnce()
    expect(ctorOptions).toHaveLength(1)
  })

  it('updates after output and resizing, and hides the scroll button in alternate-screen programs', async () => {
    await mountWorkspace()
    act(() => {
      buffers[0]!.active.baseY = 40
      buffers[0]!.active.viewportY = 10
      for (const listener of parsedListeners) listener()
    })
    expect(screen.getByRole('button', { name: 'Scroll terminal to bottom' })).toBeInTheDocument()
    act(() => {
      buffers[0]!.active.baseY = 10
      for (const listener of resizeListeners) listener()
    })
    expect(
      screen.queryByRole('button', { name: 'Scroll terminal to bottom' }),
    ).not.toBeInTheDocument()
    act(() => {
      buffers[0]!.active.baseY = 40
      for (const listener of parsedListeners) listener()
    })
    expect(screen.getByRole('button', { name: 'Scroll terminal to bottom' })).toBeInTheDocument()
    act(() => {
      buffers[0]!.active.type = 'alternate'
      for (const listener of parsedListeners) listener()
    })
    expect(
      screen.queryByRole('button', { name: 'Scroll terminal to bottom' }),
    ).not.toBeInTheDocument()
  })
})
