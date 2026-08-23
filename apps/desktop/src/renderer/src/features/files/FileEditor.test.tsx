import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { FileEditor } from './FileEditor'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

const PATH = 'C:\\demo\\README.md'

describe('FileEditor', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads the file contents into an editable buffer', async () => {
    invokeMock.mockResolvedValue({ content: 'hello world', truncated: false })
    render(<FileEditor path={PATH} onClose={() => undefined} />)

    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('hello world'))
    expect(invokeMock).toHaveBeenCalledWith('fs.readTextFile', { path: PATH })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('marks dirty edits and saves through fs.writeTextFile', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'fs.readTextFile') return { content: 'hello', truncated: false }
      if (method === 'fs.writeTextFile') return { bytesWritten: 6 }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    const onSaved = vi.fn()
    render(<FileEditor path={PATH} onClose={() => undefined} onSaved={onSaved} />)

    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('hello'))

    await user.type(buffer, '!')
    expect(screen.getByText('unsaved changes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('fs.writeTextFile', {
        path: PATH,
        content: 'hello!',
      }),
    )
    expect(onSaved).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(screen.queryByText('unsaved changes')).not.toBeInTheDocument()
  })

  it('cancel closes without writing, discarding edits', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({ content: 'saved version', truncated: false })
    const onClose = vi.fn()
    render(<FileEditor path={PATH} onClose={onClose} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('saved version'))

    await user.type(buffer, ' discarded')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalledWith(
      'fs.writeTextFile',
      expect.anything(),
    )
  })

  it('surfaces read failures (binary or over-cap files) as an alert', async () => {
    invokeMock.mockRejectedValue(new Error('binary file'))
    render(<FileEditor path="C:\\demo\\logo.png" onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('binary file')
    expect(screen.queryByRole('textbox', { name: 'File contents' })).not.toBeInTheDocument()
  })

  it('refuses to edit a truncated read so saving cannot drop the tail', async () => {
    invokeMock.mockResolvedValue({ content: 'only the head', truncated: true })
    render(<FileEditor path={PATH} onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('edit cap')
    expect(screen.queryByRole('textbox', { name: 'File contents' })).not.toBeInTheDocument()
  })

  it('shows save failures in the footer alert', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'fs.readTextFile') return { content: 'x', truncated: false }
      if (method === 'fs.writeTextFile') throw new Error('path escapes registered project folders')
      throw new Error(`unexpected method: ${String(method)}`)
    })
    render(<FileEditor path={PATH} onClose={() => undefined} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('x'))

    await user.type(buffer, 'y')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'path escapes registered project folders',
    )
  })
})
