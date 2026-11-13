import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ReviewWorkspaceProps } from './ReviewWorkspace'
import { ChangesView } from './ChangesView'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('./ReviewWorkspace', () => ({
  ReviewWorkspace: (props: ReviewWorkspaceProps) => (
    <div>
      <pre data-testid="review">
        {JSON.stringify({
          scope: props.scope,
          comparison: props.initialComparison,
          view: props.view,
          reason: props.administrationReason,
        })}
      </pre>
      <button type="button" onClick={() => props.onViewChange?.('requests')}>
        Show requests
      </button>
      {props.tools}
    </div>
  ),
}))
beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method) =>
    method === 'project.list' ? [{ id: 'p', name: 'Demo', path: 'C:\\repos\\demo' }] : null,
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

  it('lets standalone source control choose a project from the header tools', async () => {
    mocks.invoke.mockResolvedValue([
      { id: 'self-hosted', name: 'Company repo', path: 'C:\\repos\\company' },
      { id: 'github', name: 'Ari', path: 'C:\\repos\\ari' },
    ])
    const user = userEvent.setup()
    render(<ChangesView initialTab="requests" />)
    const picker = await screen.findByRole('button', { name: 'Source control project' })
    expect(picker).toHaveTextContent('Company repo')
    expect(screen.getByTestId('review')).toHaveTextContent('"view":"requests"')
    await user.click(picker)
    await user.click(screen.getByRole('option', { name: 'Ari' }))
    expect(screen.getByTestId('review')).toHaveTextContent('"projectId":"github"')
  })

  it('reports a switch to pull requests so expand and dock keep it', () => {
    const onTabChange = vi.fn()
    render(<ChangesView sessionId="s" onTabChange={onTabChange} />)
    expect(screen.getByTestId('review')).toHaveTextContent('"view":"changes"')
    expect(screen.getByTestId('review')).toHaveTextContent('"reason":null')
    fireEvent.click(screen.getByRole('button', { name: 'Show requests' }))
    expect(screen.getByTestId('review')).toHaveTextContent('"view":"requests"')
    expect(onTabChange).toHaveBeenCalledWith('requests')
  })

  it('puts expand, dock and close in the review header', () => {
    const onExpand = vi.fn()
    const { rerender } = render(<ChangesView sessionId="s" onExpand={onExpand} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand source control' }))
    expect(onExpand).toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Changes' })).not.toBeInTheDocument()
    rerender(<ChangesView sessionId="s" onDock={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dock source control' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close source control' })).toBeInTheDocument()
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
