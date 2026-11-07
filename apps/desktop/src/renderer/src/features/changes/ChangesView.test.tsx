import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import userEvent from '@testing-library/user-event'
import type { ReviewWorkspaceProps } from './ReviewWorkspace'
import { ChangesView } from './ChangesView'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('./ReviewWorkspace', () => ({
  ReviewWorkspace: (props: ReviewWorkspaceProps) => (
    <pre data-testid="review">
      {JSON.stringify({ scope: props.scope, comparison: props.initialComparison })}
    </pre>
  ),
}))
vi.mock('./ChangeRequests', () => ({
  ChangeRequests: (props: { scope: unknown }) => (
    <pre data-testid="requests">{JSON.stringify(props.scope)}</pre>
  ),
}))
beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method) =>
    method === 'project.list'
      ? [{ id: 'p', name: 'Demo', path: 'C:\\repos\\demo' }]
      : { checkpoints: [{ turnId: 't1', gitRef: 'refs/ari/s1/t1' }] },
  )
})
afterEach(() => vi.clearAllMocks())

describe('Changes route', () => {
  it('resolves child/session scope synchronously instead of using the project checkout', () => {
    render(
      <ChangesView
        sessionId="child"
        projectId="parent-project"
        initialComparison={{ kind: 'turn', turnId: 't1' }}
      />,
    )
    expect(screen.getByTestId('review')).toHaveTextContent('"sessionId":"child"')
    expect(screen.getByTestId('review')).toHaveTextContent('"kind":"turn"')
    expect(screen.queryByRole('button', { name: 'Source control project' })).not.toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('uses an explicit project or the first registered fallback without exposing cwd', async () => {
    const { rerender } = render(<ChangesView projectId="selected" />)
    expect(screen.getByTestId('review')).toHaveTextContent('"projectId":"selected"')
    rerender(<ChangesView />)
    expect(await screen.findByTestId('review')).not.toHaveTextContent('C:\\repos')
    await vi.waitFor(() =>
      expect(screen.getByTestId('review')).toHaveTextContent('"projectId":"p"'),
    )
  })

  it('lets standalone source control choose a project for both changes and requests', async () => {
    mocks.invoke.mockResolvedValue([
      { id: 'self-hosted', name: 'Company repo', path: 'C:\\repos\\company' },
      { id: 'github', name: 'Ari', path: 'C:\\repos\\ari' },
    ])
    const user = userEvent.setup()
    render(<ChangesView initialTab="requests" />)
    const picker = await screen.findByRole('button', { name: 'Source control project' })
    expect(picker).toHaveTextContent('Company repo')
    expect(screen.getByTestId('requests')).toHaveTextContent('"projectId":"self-hosted"')
    await user.click(picker)
    await user.click(screen.getByRole('option', { name: 'Ari' }))
    expect(screen.getByTestId('requests')).toHaveTextContent('"projectId":"github"')
    await user.click(screen.getByRole('tab', { name: 'Changes' }))
    expect(screen.getByTestId('review')).toHaveTextContent('"projectId":"github"')
  })

  it('keeps checkpoint history lazy while preserving existing revert actions', async () => {
    render(
      <ToastProvider>
        <ChangesView sessionId="s" />
      </ToastProvider>,
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Turn checkpoints' }))
    expect(await screen.findByRole('button', { name: 'Revert turn t1' })).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('session.load', { sessionId: 's' })
  })

  it('keeps requests lazy and separate from local review', () => {
    render(<ChangesView sessionId="s" />)
    expect(screen.queryByTestId('requests')).not.toBeInTheDocument()
    expect(screen.getByTestId('review')).toHaveTextContent('"sessionId":"s"')
    fireEvent.click(screen.getByRole('tab', { name: 'Pull requests' }))
    expect(screen.getByTestId('requests')).toHaveTextContent('"sessionId":"s"')
    expect(screen.queryByTestId('review')).not.toBeInTheDocument()
  })

  it('moves tab focus with arrow keys and reports selection for expand/dock', () => {
    const onTabChange = vi.fn()
    render(<ChangesView sessionId="s" onTabChange={onTabChange} />)
    const changes = screen.getByRole('tab', { name: 'Changes' })
    changes.focus()
    fireEvent.keyDown(changes, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Pull requests' })).toHaveFocus()
    expect(onTabChange).toHaveBeenCalledWith('requests')
  })

  it('surfaces fallback scope failures and permits retry', async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error('project read failed'))
      .mockResolvedValue([{ id: 'p' }])
    render(<ChangesView />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load projects')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await vi.waitFor(() =>
      expect(screen.getByTestId('review')).toHaveTextContent('"projectId":"p"'),
    )
  })
})
