import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlConnectionsSettings } from './SourceControlConnectionsSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
beforeEach(() => mocks.invoke.mockReset().mockResolvedValue({ ok: true, value: {} }))

describe('hosting connections', () => {
  it('offers every provider and clears a token when changing provider or completing connection', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<SourceControlConnectionsSettings environment={null} onChanged={changed} />)
    expect(screen.getAllByRole('button', { name: /^Configure / })).toHaveLength(6)
    await user.click(screen.getByRole('button', { name: 'Configure Forgejo / Gitea' }))
    const token = screen.getByLabelText('Forgejo / Gitea access token')
    expect(token).toHaveAttribute('type', 'password')
    await user.type(token, 'test-secret')
    await user.click(screen.getByRole('button', { name: 'Configure Bitbucket' }))
    expect(screen.getByLabelText('Bitbucket access token')).toHaveValue('')
    await user.type(screen.getByLabelText('Bitbucket access token'), 'new-secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(mocks.invoke).toHaveBeenCalledWith('scm.connect', {
      provider: 'bitbucket',
      instance: 'https://bitbucket.org',
      token: 'new-secret',
      username: '',
    })
    expect(changed).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Configure Bitbucket' }))
    expect(screen.getByLabelText('Bitbucket access token')).toHaveValue('')
  })

  it('keeps the form open and surfaces denied permissions', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'failed', message: 'This token does not have permission.' },
    })
    render(<SourceControlConnectionsSettings environment={null} onChanged={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Configure Azure DevOps' }))
    const instance = screen.getByLabelText('Azure DevOps instance URL')
    await user.clear(instance)
    await user.type(instance, 'https://dev.azure.com/team')
    await user.type(screen.getByLabelText('Azure DevOps access token'), 'test-secret')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have permission')
    expect(screen.getByLabelText('Azure DevOps instance URL')).toHaveValue(
      'https://dev.azure.com/team',
    )
  })
})
