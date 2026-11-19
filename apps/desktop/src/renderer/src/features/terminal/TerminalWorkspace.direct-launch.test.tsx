import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import { TerminalWorkspace } from './TerminalWorkspace'
import {
  terminalWorkspaceActions as actions,
  terminalWorkspaceSnapshot,
} from './terminal-workspace-state'
import { resetTerminalDock, terminalDockState } from './terminal-dock'
import { leaves } from '../split/split-layout'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke, subscribe: vi.fn(() => () => undefined) } }))
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div className="xterm" data-testid="native-terminal" data-terminal-id={terminalId}>
      <textarea
        aria-label="Test terminal input"
        onContextMenu={(event) => event.stopPropagation()}
      />
    </div>
  ),
}))
vi.mock('../files/FileExplorer', () => ({ FileExplorer: () => <div>Workspace files</div> }))
vi.mock('../changes/ChangesView', () => ({ ChangesView: () => <div>Workspace changes</div> }))
vi.mock('../usage/UsagePage', () => ({ UsagePage: () => <div>Provider usage</div> }))

const project: Project = {
  id: 'project',
  path: 'D:\\Projects\\App',
  name: 'App',
  colorIndex: 0,
  createdAt: 0,
  lastOpenedAt: 0,
  open: true,
  status: 'ok',
}
const props = {
  projects: [project],
  visible: true,
  onAddProject: vi.fn(),
  onSettings: vi.fn(),
  onPalette: vi.fn(),
}
const launches = () => invoke.mock.calls.filter(([method]) => method === 'terminal.launch')

beforeEach(() => {
  actions.reset()
  resetTerminalDock()
  localStorage.clear()
  invoke.mockReset().mockImplementation(async (method: string, params?: { id?: string }) => {
    if (method === 'terminal.profiles')
      return {
        platform: 'win32',
        shell: 'powershell.exe',
        profiles: [
          { id: 'shell', label: 'PowerShell', available: true },
          { id: 'claude', label: 'Claude Code', available: true },
          { id: 'codex', label: 'Codex', available: true },
        ],
      }
    if (method === 'terminal.launch')
      return {
        id: params?.id,
        cwd: project.path,
        exited: false,
        exitCode: null,
        cols: 120,
        rows: 36,
      }
    return undefined
  })
})
afterEach(() => {
  actions.reset()
  resetTerminalDock()
})

async function ready() {
  await waitFor(() => expect(screen.getAllByTestId('native-terminal')).toHaveLength(1))
  return userEvent.setup()
}

describe('TerminalWorkspace direct launch', () => {
  it('opens the first shell on entry once, including StrictMode, without a form', async () => {
    render(
      <StrictMode>
        <TerminalWorkspace {...props} />
      </StrictMode>,
    )
    await ready()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(launches()).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(
      'terminal.launch',
      expect.objectContaining({ profile: 'shell', cwd: project.path }),
    )
    expect(terminalWorkspaceSnapshot().tasks[0]?.title).toBe('Space 1')
    expect(invoke.mock.calls.some(([method]) => method === 'session.create')).toBe(false)
  })

  it('adds a shell immediately when New terminal is clicked', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'New terminal' }))
    await waitFor(() => expect(launches()).toHaveLength(2))
    expect(terminalWorkspaceSnapshot().tasks).toHaveLength(1)
    expect(leaves(terminalWorkspaceSnapshot().tasks[0]!.layout.root)).toHaveLength(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('launches Codex directly from the program dropdown', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'Choose terminal program' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(launches()).toHaveLength(2))
    expect(invoke).toHaveBeenCalledWith(
      'terminal.launch',
      expect.objectContaining({ profile: 'codex', cwd: project.path }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('splits straight into a shell and parks a pane without stopping its process', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    const first = terminalDockState().tabs[0]!.id
    await user.click(screen.getByRole('button', { name: 'Split terminal right' }))
    await waitFor(() => expect(screen.getAllByTestId('native-terminal')).toHaveLength(2))
    expect(terminalWorkspaceSnapshot().tasks).toHaveLength(1)
    expect(
      leaves(terminalWorkspaceSnapshot().tasks[0]!.layout.root).map((pane) => pane.terminalId),
    ).toContain(first)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Park terminal pane' })[0]!)
    expect(terminalDockState().tabs).toHaveLength(2)
    expect(invoke.mock.calls.some(([method]) => method === 'terminal.kill')).toBe(false)
  })

  it('does not launch again when switching away and back', async () => {
    const view = render(<TerminalWorkspace {...props} />)
    await ready()
    view.rerender(<TerminalWorkspace {...props} visible={false} />)
    view.rerender(<TerminalWorkspace {...props} visible />)
    expect(launches()).toHaveLength(1)
  })

  it('right-clicks terminal input to split without opening a form', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    const first = terminalDockState().tabs[0]!.id
    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Test terminal input' }), {
      clientX: 200,
      clientY: 160,
    })
    await user.click(screen.getByRole('menuitem', { name: 'Split right' }))
    await waitFor(() => expect(screen.getAllByTestId('native-terminal')).toHaveLength(2))
    expect(
      leaves(terminalWorkspaceSnapshot().tasks[0]!.layout.root).map((pane) => pane.terminalId),
    ).toContain(first)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('splits the right-clicked pane rather than the previously focused pane', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'Split terminal right' }))
    await waitFor(() => expect(screen.getAllByTestId('native-terminal')).toHaveLength(2))
    const [first, second] = terminalDockState().tabs
    fireEvent.contextMenu(screen.getAllByRole('textbox', { name: 'Test terminal input' })[0]!, {
      clientX: 200,
      clientY: 160,
    })
    await user.click(screen.getByRole('menuitem', { name: 'Split down' }))
    await waitFor(() => expect(screen.getAllByTestId('native-terminal')).toHaveLength(3))
    const root = terminalWorkspaceSnapshot().tasks[0]!.layout.root
    expect(root.kind).toBe('split')
    if (root.kind !== 'split') throw new Error('Expected a split root')
    expect(leaves(root.a).map((pane) => pane.terminalId)).toContain(first!.id)
    expect(leaves(root.b).map((pane) => pane.terminalId)).toEqual([second!.id])
  })

  it('leaves the search input context menu alone', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'Find in terminal' }))
    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Find terminal text' }), {
      clientX: 200,
      clientY: 160,
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not replace a terminal tab the user deliberately parked', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    await user.click(screen.getByRole('button', { name: 'Park Space 1' }))
    expect(terminalWorkspaceSnapshot().tasks[0]?.closed).toBe(true)
    expect(launches()).toHaveLength(1)
    expect(terminalDockState().tabs).toHaveLength(1)
  })

  it('opens a new space with its own shell and preserves the previous space', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    const first = terminalWorkspaceSnapshot().tasks[0]!
    await user.click(screen.getByRole('button', { name: 'New space' }))
    await waitFor(() => expect(launches()).toHaveLength(2))
    const spaces = terminalWorkspaceSnapshot().tasks
    expect(spaces.map((space) => space.title)).toEqual(['Space 1', 'Space 2'])
    expect(spaces[0]!.layout).toBe(first.layout)
    expect(leaves(spaces[1]!.layout.root)).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates spaces and adds terminals with separate shortcuts from terminal input', async () => {
    render(<TerminalWorkspace {...props} />)
    await ready()
    const first = terminalWorkspaceSnapshot().tasks[0]!
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Test terminal input' }), {
      key: 'N',
      ctrlKey: true,
      shiftKey: true,
    })
    await waitFor(() => expect(launches()).toHaveLength(2))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Test terminal input' }), {
      key: 'T',
      ctrlKey: true,
      shiftKey: true,
    })
    await waitFor(() => expect(launches()).toHaveLength(3))
    const spaces = terminalWorkspaceSnapshot().tasks
    expect(spaces).toHaveLength(2)
    expect(spaces[0]!.layout).toBe(first.layout)
    expect(leaves(spaces[1]!.layout.root)).toHaveLength(2)
    expect(terminalWorkspaceSnapshot().activeTaskId).toBe(spaces[1]!.id)
  })

  it('keeps New space available when the current space reaches its pane limit', async () => {
    render(<TerminalWorkspace {...props} />)
    const user = await ready()
    for (let count = 1; count < 6; count++)
      await user.click(screen.getByRole('button', { name: 'New terminal' }))
    await waitFor(() => expect(launches()).toHaveLength(6))
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Choose terminal program' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New space' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'New space' }))
    await waitFor(() => expect(launches()).toHaveLength(7))
    expect(terminalWorkspaceSnapshot().tasks).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeEnabled()
  })
})
