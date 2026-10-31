import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
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
vi.mock('./SourceControlWorkspace', () => ({
  SourceControlWorkspace: (props: ReviewWorkspaceProps) => (
    <pre data-testid="source-control">{JSON.stringify(props.scope)}</pre>
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

  it('routes Source control separately from review', () => {
    render(<ChangesView sessionId="s" sourceControl />)
    expect(screen.getByTestId('source-control')).toHaveTextContent('"sessionId":"s"')
    expect(screen.queryByTestId('review')).not.toBeInTheDocument()
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
