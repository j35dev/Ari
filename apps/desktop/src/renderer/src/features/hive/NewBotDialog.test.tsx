import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import { NewBotDialog } from './NewBotDialog'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const CREATED: Bot = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '🤖',
  personaMd: '',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

const PROJECTS = [{ id: 'proj_1', name: 'Ari' }]

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (method: string) => {
    if (method === 'providers.models') return {}
    return []
  })
})

describe('NewBotDialog', () => {
  it('uses the first project when the projects arrive after it mounts', async () => {
    const onCreate = vi.fn(async () => CREATED)
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      driverKind: 'ari-core' as const,
      modelId: null,
      onCreate,
      onCreated: vi.fn(),
    }
    const { rerender } = render(<NewBotDialog {...props} projects={[]} />)
    rerender(<NewBotDialog {...props} projects={PROJECTS} />)

    await userEvent.click(screen.getByRole('button', { name: 'Forge' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj_1' })),
    )
  })

  it('drafts a whole bot from one line about the job', async () => {
    const onCreate = vi.fn(async (input: { name: string }) => ({ ...CREATED, ...input }))
    const onCreated = vi.fn()
    render(
      <NewBotDialog
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        driverKind="ari-core"
        modelId={null}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    )

    const dialog = await screen.findByRole('dialog', { name: 'New bot' })
    await userEvent.type(
      dialog.querySelector('input[placeholder^="Watch"]')!,
      'watch our alert pipeline and page me',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Draft' }))

    // The draft lands in the editable fields; the name belongs to the archetype.
    const name = screen.getAllByRole('textbox', { name: 'Name' })[0]!
    expect(name).toHaveValue('Watch')
    expect(screen.getByDisplayValue('Ops')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Watch', title: 'Ops' }),
      ),
    )
  })

  it('keeps Draft idle while the line is empty', async () => {
    render(
      <NewBotDialog
        open
        onOpenChange={vi.fn()}
        projects={PROJECTS}
        driverKind="ari-core"
        modelId={null}
        onCreate={vi.fn(async () => CREATED)}
        onCreated={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: 'Draft' })).toHaveAttribute('disabled')
  })
})
