import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeRequests } from './ChangeRequests'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))

const connection = {
  ok: true,
  value: {
    repository: {
      provider: 'github',
      instance: 'https://github.com',
      name: 'acme/demo',
      remote: 'origin',
      url: 'https://github.com/acme/demo',
    },
    requests: [
      {
        number: 4,
        title: 'Fix the bug',
        url: 'https://github.com/acme/demo/pull/4',
        draft: false,
        author: 'sam',
        head: 'feature',
        base: 'main',
        body: 'A focused fix.',
        state: 'open',
        headOid: 'a'.repeat(40),
        updatedAt: '2026-11-06',
        capabilities: {
          diff: true,
          comments: true,
          review: ['comment', 'approve'],
          inlineReview: false,
          merge: ['squash'],
          draft: true,
          close: true,
        },
      },
    ],
    detail: '1 open pull request.',
  },
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) =>
    method === 'scm.requests'
      ? connection
      : method === 'scm.request'
        ? {
            ok: true,
            value: { ...connection.value.requests[0], repository: connection.value.repository },
          }
        : { opened: true },
  )
})

describe('ChangeRequests', () => {
  it('shows the recognized host and opens the request', async () => {
    const user = userEvent.setup()
    render(<ChangeRequests scope={{ projectId: 'p' }} />)
    expect(await screen.findByRole('heading', { name: 'acme/demo' })).toBeInTheDocument()
    expect(screen.getByText('1 open pull request.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Fix the bug/ }))
    expect(await screen.findByText('A focused fix.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open request on host' }))
    expect(mocks.invoke).toHaveBeenCalledWith('shell.openUrl', {
      url: 'https://github.com/acme/demo/pull/4',
    })
  })

  it('says when a recognized forge is not connected', async () => {
    mocks.invoke.mockResolvedValue({
      ok: true,
      value: {
        repository: { ...connection.value.repository, provider: 'forgejo', name: 'acme/demo' },
        requests: [],
        detail: 'Codeberg is recognized. Listing, review, and merge are not connected.',
      },
    })
    render(<ChangeRequests scope={{ sessionId: 's' }} />)
    expect(await screen.findByText(/not connected/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check out/i })).not.toBeInTheDocument()
  })

  it('checks out a request only after confirmation', async () => {
    const user = userEvent.setup()
    const onCheckedOut = vi.fn(async () => undefined)
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'scm.requests') return connection
      if (method === 'scm.request')
        return {
          ok: true,
          value: { ...connection.value.requests[0], repository: connection.value.repository },
        }
      if (method === 'scm.checkout') {
        return {
          ok: true,
          value: {
            path: 'D:\\wt\\github-4',
            branch: 'ari/request/github/4',
            commit: 'a'.repeat(40),
            number: 4,
            created: true,
          },
        }
      }
      return { opened: true }
    })
    render(<ChangeRequests scope={{ projectId: 'p' }} onCheckedOut={onCheckedOut} />)
    await user.click(await screen.findByRole('button', { name: /Fix the bug/ }))
    await user.click(await screen.findByRole('button', { name: 'Check out' }))
    expect(screen.getByText(/open a session there/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.invoke).not.toHaveBeenCalledWith('scm.checkout', { projectId: 'p', number: 4 })
    await user.click(screen.getByRole('button', { name: 'Check out' }))
    await user.click(screen.getByRole('button', { name: 'Create worktree' }))
    expect(await screen.findByText(/separate worktree/)).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('scm.checkout', { projectId: 'p', number: 4 })
    expect(onCheckedOut).toHaveBeenCalledWith('D:\\wt\\github-4')
  })
})
