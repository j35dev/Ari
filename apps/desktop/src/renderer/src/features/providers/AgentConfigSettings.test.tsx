import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigSettings } from './AgentConfigSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: vi.fn() } }))

const PI_FILES = {
  dir: '/home/u/.pi/agent',
  files: [
    {
      id: 'settings',
      label: 'settings.json',
      path: '/home/u/.pi/agent/settings.json',
      format: 'json' as const,
      description: 'Default provider and model.',
      exists: true,
      size: 186,
    },
    {
      id: 'system',
      label: 'SYSTEM.md',
      path: '/home/u/.pi/agent/SYSTEM.md',
      format: 'markdown' as const,
      description: 'Replaces the system prompt.',
      exists: false,
      size: 0,
    },
  ],
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'providers.configFiles') return PI_FILES
    if (method === 'providers.readConfig') {
      return { content: '{"defaultModel":"sonnet"}', exists: true, path: 'x', truncated: false }
    }
    if (method === 'providers.writeConfig') return { ok: true, bytesWritten: 12 }
    throw new Error(`unexpected ${method}`)
  })
})

describe('AgentConfigSettings', () => {
  it("lists the selected agent's config files with their state", async () => {
    render(<AgentConfigSettings />)
    expect(await screen.findByText('settings.json')).toBeInTheDocument()
    expect(screen.getByText('186 B')).toBeInTheDocument()
    // An absent optional file is offered, not hidden — that is how a user
    // learns SYSTEM.md exists at all.
    expect(screen.getByText('not created')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit settings.json' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit SYSTEM.md' })).toHaveTextContent('Create')
    expect(screen.getByText('/home/u/.pi/agent')).toBeInTheDocument()
  })

  it('opens a file, edits it, and saves through the RPC', async () => {
    const user = userEvent.setup()
    render(<AgentConfigSettings />)
    await user.click(await screen.findByRole('button', { name: 'Edit settings.json' }))

    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    expect(editor).toHaveValue('{"defaultModel":"sonnet"}')
    // Save stays disabled until something actually changed.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, '{{"quietStartup":true}')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('providers.writeConfig', {
        kind: 'pi',
        fileId: 'settings',
        content: '{"quietStartup":true}',
      })
    })
  })

  it('surfaces a rejected save instead of pretending it landed', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'providers.configFiles') return PI_FILES
      if (method === 'providers.readConfig') {
        return { content: '{}', exists: true, path: 'x', truncated: false }
      }
      return { ok: false, error: 'settings.json is not valid JSON: Unexpected end of input' }
    })
    render(<AgentConfigSettings />)
    await user.click(await screen.findByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    await user.type(editor, '{{')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON')
  })

  it('switches agents and re-lists for the new one', async () => {
    const user = userEvent.setup()
    render(<AgentConfigSettings />)
    await screen.findByText('settings.json')
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('providers.configFiles', { kind: 'codex' })
    })
  })

  it('says so plainly when Ari has no layout for an agent', async () => {
    mocks.invoke.mockImplementation(async () => ({ dir: null, files: [] }))
    render(<AgentConfigSettings />)
    expect(await screen.findByText(/no confirmed config layout/i)).toBeInTheDocument()
  })
})
