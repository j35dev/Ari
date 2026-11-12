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

const SCOPE = { projectId: 'proj_1' }
const PATH = 'README.md'

describe('FileEditor', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads the file contents into an editable buffer', async () => {
    invokeMock.mockResolvedValue({ content: 'hello world', truncated: false })
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} />)

    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('hello world'))
    expect(invokeMock).toHaveBeenCalledWith('fs.readTextFile', { ...SCOPE, path: PATH })
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
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} onSaved={onSaved} />)

    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('hello'))

    await user.type(buffer, '!')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('fs.writeTextFile', {
        ...SCOPE,
        path: PATH,
        content: 'hello!',
      }),
    )
    expect(onSaved).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('closes straight away when there is nothing to lose', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({ content: 'clean', truncated: false })
    const onClose = vi.fn()
    render(<FileEditor scope={SCOPE} path={PATH} onClose={onClose} />)
    await screen.findByRole('textbox', { name: 'File contents' })

    await user.click(screen.getByRole('button', { name: 'Close file' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('asks before discarding unsaved edits, and can go back to editing', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({ content: 'draft', truncated: false })
    const onClose = vi.fn()
    render(<FileEditor scope={SCOPE} path={PATH} onClose={onClose} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('draft'))
    await user.type(buffer, '!')

    await user.click(screen.getByRole('button', { name: 'Close file' }))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
    expect(buffer).toHaveValue('draft!')
  })

  it('saves with Ctrl+S', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'fs.readTextFile') return { content: 'a', truncated: false }
      return { bytesWritten: 2 }
    })
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('a'))

    await user.type(buffer, 'b{Control>}s{/Control}')
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('fs.writeTextFile', {
        ...SCOPE,
        path: PATH,
        content: 'ab',
      }),
    )
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('keeps Windows line endings when it saves', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'fs.readTextFile') return { content: 'one\r\ntwo', truncated: false }
      return { bytesWritten: 9 }
    })
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('one\ntwo'))
    expect(screen.getByText('CRLF')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.type(buffer, '!')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('fs.writeTextFile', {
        ...SCOPE,
        path: PATH,
        content: 'one\r\ntwo!',
      }),
    )
  })

  it('discards edits without writing once the user confirms', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({ content: 'saved version', truncated: false })
    const onClose = vi.fn()
    render(<FileEditor scope={SCOPE} path={PATH} onClose={onClose} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('saved version'))

    await user.type(buffer, ' discarded')
    await user.click(screen.getByRole('button', { name: 'Close file' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalledWith('fs.writeTextFile', expect.anything())
  })

  it('surfaces read failures (binary or over-cap files) as an alert', async () => {
    invokeMock.mockRejectedValue(new Error('binary file'))
    render(<FileEditor scope={SCOPE} path="logo.png" onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('binary file')
    expect(screen.queryByRole('textbox', { name: 'File contents' })).not.toBeInTheDocument()
  })

  it('refuses to edit a truncated read so saving cannot drop the tail', async () => {
    invokeMock.mockResolvedValue({ content: 'only the head', truncated: true })
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('edit limit')
    expect(screen.queryByRole('textbox', { name: 'File contents' })).not.toBeInTheDocument()
  })

  it('shows save failures in the footer alert', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'fs.readTextFile') return { content: 'x', truncated: false }
      if (method === 'fs.writeTextFile') throw new Error('path escapes registered project folders')
      throw new Error(`unexpected method: ${String(method)}`)
    })
    render(<FileEditor scope={SCOPE} path={PATH} onClose={() => undefined} />)
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('x'))

    await user.type(buffer, 'y')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'path escapes registered project folders',
    )
  })
})
