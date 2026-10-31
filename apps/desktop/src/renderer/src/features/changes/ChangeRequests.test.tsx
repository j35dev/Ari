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
      },
    ],
    detail: '1 open pull request.',
  },
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) =>
    method === 'scm.requests' ? connection : { opened: true },
  )
})

describe('ChangeRequests', () => {
  it('shows the recognized host and opens the request', async () => {
    const user = userEvent.setup()
    render(<ChangeRequests scope={{ projectId: 'p' }} />)
    expect(await screen.findByText('acme/demo · 1 open pull request.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '#4 Fix the bug' }))
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
  })
})
