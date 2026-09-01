import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionImport } from './SessionImport'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: vi.fn() } }))

const SESSIONS = [
  {
    kind: 'pi' as const,
    id: 'pi-1',
    path: '/p/one.jsonl',
    cwd: 'D:\\Projects\\Ari',
    title: 'refactor the store',
    startedAt: Date.parse('2026-08-01T10:00:00.000Z'),
    updatedAt: Date.parse('2026-08-02T10:00:00.000Z'),
    messageCount: 12,
    imported: false,
  },
  {
    kind: 'pi' as const,
    id: 'pi-2',
    path: '/p/two.jsonl',
    cwd: 'D:\\Projects\\Ari',
    title: 'already here',
    startedAt: 0,
    updatedAt: 0,
    messageCount: 3,
    imported: true,
  },
]

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'sessions.importable') return SESSIONS
    if (method === 'sessions.import') {
      return { ok: true, sessionId: 'sess_new', title: 'refactor the store', messageCount: 12 }
    }
    throw new Error(`unexpected ${method}`)
  })
})

describe('SessionImport', () => {
  it("lists pi's sessions and disables the ones already in Ari", async () => {
    render(<SessionImport />)
    expect(await screen.findByText('refactor the store')).toBeInTheDocument()
    expect(screen.getByText(/12 messages/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import refactor the store' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Import already here' })).toBeDisabled()
    expect(screen.getByText('in Ari')).toBeInTheDocument()
  })

  it('says plainly that pi keeps its own copy', async () => {
    render(<SessionImport />)
    expect(await screen.findByText(/stays resumable in pi/)).toBeInTheDocument()
  })

  it('imports a session and reports what landed', async () => {
    const user = userEvent.setup()
    const onImported = vi.fn()
    render(<SessionImport onImported={onImported} />)
    await user.click(await screen.findByRole('button', { name: 'Import refactor the store' }))

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('sessions.import', { path: '/p/one.jsonl' })
    })
    expect(onImported).toHaveBeenCalledWith('sess_new')
    expect(await screen.findByText(/Imported "refactor the store"/)).toBeInTheDocument()
  })

  it('shows which session is importing and blocks duplicate actions while it runs', async () => {
    let finishImport:
      | ((result: { ok: true; sessionId: string; title: string; messageCount: number }) => void)
      | undefined
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'sessions.importable') return SESSIONS
      if (method === 'sessions.import') {
        return new Promise((resolve) => {
          finishImport = resolve
        })
      }
      throw new Error(`unexpected ${method}`)
    })

    const user = userEvent.setup()
    render(<SessionImport />)
    await user.click(await screen.findByRole('button', { name: 'Import refactor the store' }))

    expect(screen.getByRole('status')).toHaveTextContent('Importing “refactor the store”…')
    expect(screen.getByRole('button', { name: 'Importing refactor the store' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Import already here' })).toBeDisabled()

    finishImport?.({
      ok: true,
      sessionId: 'sess_new',
      title: 'refactor the store',
      messageCount: 12,
    })
    expect(await screen.findByText(/Imported "refactor the store"/)).toBeInTheDocument()
  })

  it('surfaces a refusal instead of pretending it worked', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'sessions.importable') return SESSIONS
      return {
        ok: false,
        error: 'No Ari project for D:\\Nowhere — open the folder first, then import.',
      }
    })
    render(<SessionImport />)
    await user.click(await screen.findByRole('button', { name: 'Import refactor the store' }))

    const failedSession = screen.getByText('refactor the store').closest('li')
    if (failedSession === null) throw new Error('expected the failed session row')
    expect(within(failedSession).getByText('error')).toHaveClass('bg-danger-subtle', 'text-danger')
    expect(within(failedSession).getByRole('alert')).toHaveTextContent('open the folder first')
    expect(within(failedSession).getByRole('button', { name: 'Retry refactor the store' })).toHaveTextContent(
      'Retry',
    )
    const importedSession = screen.getByText('already here').closest('li')
    if (importedSession === null) throw new Error('expected the imported session row')
    expect(within(importedSession).queryByRole('alert')).toBeNull()
  })

  it('says so when pi has no sessions on this machine', async () => {
    mocks.invoke.mockImplementation(async () => [])
    render(<SessionImport />)
    expect(await screen.findByText(/No pi sessions found/)).toBeInTheDocument()
  })
})
