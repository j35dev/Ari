import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionImportDialog } from './SessionImportDialog'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: vi.fn() } }))

const SESSION = {
  kind: 'pi' as const,
  id: 'pi-1',
  candidateId: 'candidate-one',
  cwd: '/projects/ari',
  title: 'build the importer',
  startedAt: 1,
  updatedAt: 2,
  messageCount: 5,
  imported: false,
}

beforeEach(() => {
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'sessions.importable') return [SESSION]
    if (method === 'sessions.import') {
      return { ok: true, sessionId: 'sess_imported', title: SESSION.title, messageCount: 5 }
    }
    throw new Error(`unexpected ${method}`)
  })
})

describe('SessionImportDialog', () => {
  it('starts with source selection, then lists only the project Pi sessions', async () => {
    const user = userEvent.setup()
    render(
      <SessionImportDialog
        open
        project={{ id: 'proj_ari', name: 'Ari' }}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Import' })).toBeInTheDocument()
    const dialogStyle = screen.getByRole('dialog').getAttribute('style') ?? ''
    expect(dialogStyle).toContain('width: min(920px, 92vw)')
    expect(dialogStyle).toContain('height: min(680px, 86vh)')
    expect(dialogStyle).toContain('overflow: hidden')
    expect(screen.getByText('Choose a source')).toBeInTheDocument()
    expect(screen.queryByText(SESSION.title)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Pi/ }))
    expect(await screen.findByText(SESSION.title)).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('sessions.importable', { projectId: 'proj_ari' })
  })

  it('uses the project-specific empty state', async () => {
    mocks.invoke.mockResolvedValue([])
    const user = userEvent.setup()
    render(
      <SessionImportDialog
        open
        project={{ id: 'proj_ari', name: 'Ari' }}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Pi/ }))
    expect(await screen.findByText('No Pi sessions found for this project.')).toBeInTheDocument()
  })

  it('reports the imported Ari session and closes after success', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onImported = vi.fn()
    render(
      <SessionImportDialog
        open
        project={{ id: 'proj_ari', name: 'Ari' }}
        onClose={onClose}
        onImported={onImported}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Pi/ }))
    await user.click(await screen.findByRole('button', { name: `Import ${SESSION.title}` }))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith('sess_imported'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open and puts a failed import under its row', async () => {
    mocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'sessions.importable') return [SESSION]
      return { ok: false, error: 'The source transcript could not be read.' }
    })
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <SessionImportDialog
        open
        project={{ id: 'proj_ari', name: 'Ari' }}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Pi/ }))
    await user.click(await screen.findByRole('button', { name: `Import ${SESSION.title}` }))

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
