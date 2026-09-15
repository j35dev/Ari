import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubHubItem } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { HubWorkspace } from './HubWorkspace'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: mocks.invoke,
    subscribe: vi.fn(() => () => undefined),
  },
}))

vi.mock('../transcript/MarkdownBlock', () => ({
  MarkdownBlock: ({ text }: { text: string }) => <div>{text}</div>,
}))

const project: Project = {
  id: 'proj_ari',
  name: 'Ari',
  path: 'D:\\Projects\\Ari',
  colorIndex: 0,
  createdAt: 1,
  lastOpenedAt: 1,
  open: true,
  status: 'ok',
}

const other: Project = {
  ...project,
  id: 'proj_other',
  name: 'Other',
  path: 'D:\\Projects\\Other',
}

const pr: GitHubHubItem = {
  kind: 'pr',
  number: 231,
  title: 'Restyle child delegation settings',
  url: 'https://github.com/j35dev/Ari/pull/231',
  state: 'OPEN',
  isDraft: false,
  author: 'ada',
  labels: [{ name: 'ui', color: '5319e7' }],
  updatedAt: '2026-09-15T11:00:00Z',
  headRefName: 'fix/settings',
  body: '',
}

const issue: GitHubHubItem = {
  kind: 'issue',
  number: 9,
  title: 'Crash on open',
  url: 'https://github.com/j35dev/Ari/issues/9',
  state: 'OPEN',
  isDraft: false,
  author: 'lin',
  labels: [],
  updatedAt: '2026-09-15T10:00:00Z',
  body: 'Steps to reproduce.',
}

describe('HubWorkspace', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (method: string, params: { kind?: string }) => {
      if (method === 'github.list') {
        return { ok: true, items: params.kind === 'issue' ? [issue] : [pr] }
      }
      if (method === 'github.view') {
        return { ok: true, item: { ...pr, body: 'Does the thing.' } }
      }
      if (method === 'shell.openUrl') return { opened: true }
      return {}
    })
  })

  it('lists pull requests for the initial project and opens a detail', async () => {
    const user = userEvent.setup()
    render(
      <HubWorkspace
        projects={[project, other]}
        initialProjectId="proj_ari"
        onBack={() => undefined}
      />,
    )

    expect(screen.getByRole('navigation', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ari' })).toHaveAttribute('aria-current', 'page')

    expect(
      await screen.findByRole('button', { name: /Restyle child delegation settings/ }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('github.list', {
        projectId: 'proj_ari',
        kind: 'pr',
        state: 'open',
      }),
    )

    await user.click(screen.getByRole('button', { name: /Restyle child delegation settings/ }))
    expect(await screen.findByText('Does the thing.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open on GitHub' }))
    expect(mocks.invoke).toHaveBeenCalledWith('shell.openUrl', {
      url: 'https://github.com/j35dev/Ari/pull/231',
    })
  })

  it('switches project and kind', async () => {
    const user = userEvent.setup()
    render(
      <HubWorkspace
        projects={[project, other]}
        initialProjectId="proj_ari"
        onBack={() => undefined}
      />,
    )
    await screen.findByRole('button', { name: /Restyle child delegation settings/ })

    await user.click(screen.getByRole('button', { name: 'Other' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('github.list', {
        projectId: 'proj_other',
        kind: 'pr',
        state: 'open',
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Issues' }))
    expect(await screen.findByRole('button', { name: /Crash on open/ })).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('github.list', {
        projectId: 'proj_other',
        kind: 'issue',
        state: 'open',
      }),
    )
  })

  it('shows a gh failure in the list pane', async () => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'github.list') {
        return {
          ok: false,
          items: [],
          error:
            'the GitHub CLI (gh) is not installed — get it at cli.github.com, then authenticate with `gh auth login`',
        }
      }
      return {}
    })
    render(
      <HubWorkspace projects={[project]} initialProjectId="proj_ari" onBack={() => undefined} />,
    )
    expect(await screen.findByText(/cli.github.com/)).toBeInTheDocument()
  })

  it('calls onBack from the sidebar', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<HubWorkspace projects={[project]} onBack={onBack} />)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
