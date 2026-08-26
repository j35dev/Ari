import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { FileExplorer } from './FileExplorer'
import { FILE_MIME } from '../composer/drag-file'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

const ROOT = 'C:\\demo'
const SRC_DIR = 'C:\\demo\\src'

const ROOT_ENTRIES = [
  { name: 'src', type: 'dir' as const, size: 0 },
  { name: 'README.md', type: 'file' as const, size: 42 },
]

const SRC_ENTRIES = [{ name: 'main.ts', type: 'file' as const, size: 120 }]

function mockFs(): void {
  invokeMock.mockImplementation(async (method, params) => {
    if (method !== 'fs.list') throw new Error(`unexpected method: ${String(method)}`)
    const path = (params as { path: string }).path
    if (path === ROOT) return structuredClone(ROOT_ENTRIES)
    if (path === SRC_DIR) return structuredClone(SRC_ENTRIES)
    throw new Error('path does not exist')
  })
}

describe('FileExplorer', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    mockFs()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders root entries from fs.list on mount', async () => {
    render(<FileExplorer root={ROOT} />)

    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /^README\.md/ })).toBeInTheDocument()
    expect(screen.getByText('42 B')).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('fs.list', { path: ROOT })
  })

  it('expands a directory on click, listing its path once', async () => {
    const user = userEvent.setup()
    render(<FileExplorer root={ROOT} />)
    await screen.findByRole('treeitem', { name: /^README\.md/ })

    await user.click(screen.getByRole('button', { name: 'src' }))
    expect(await screen.findByRole('treeitem', { name: /^main\.ts/ })).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('fs.list', { path: SRC_DIR })

    // Collapsing and re-expanding serves from cache.
    await user.click(screen.getByRole('button', { name: 'src' }))
    await user.click(screen.getByRole('button', { name: 'src' }))
    expect(
      await screen.findByRole('treeitem', { name: /^main\.ts/ }),
    ).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('refresh re-lists the root plus every expanded directory', async () => {
    const user = userEvent.setup()
    render(<FileExplorer root={ROOT} />)
    await screen.findByRole('treeitem', { name: /^README\.md/ })
    await user.click(screen.getByRole('button', { name: 'src' }))
    await screen.findByRole('treeitem', { name: /^main\.ts/ })
    invokeMock.mockClear()

    await user.click(screen.getByRole('button', { name: 'Refresh file explorer' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2)
      expect(invokeMock).toHaveBeenNthCalledWith(1, 'fs.list', { path: ROOT })
      expect(invokeMock).toHaveBeenNthCalledWith(2, 'fs.list', { path: SRC_DIR })
    })
  })

  it('surfaces fs.list failures in an alert region', async () => {
    invokeMock.mockRejectedValue(new Error('path does not exist'))
    render(<FileExplorer root="/missing" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('path does not exist')
  })

  it('opens a clicked file in the editor and refreshes after save', async () => {
    const user = userEvent.setup()
    invokeMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'fs.list') {
        const path = (params as { path: string }).path
        if (path === ROOT) return structuredClone(ROOT_ENTRIES)
        throw new Error('path does not exist')
      }
      if (method === 'fs.readTextFile') return { content: 'saved version', truncated: false }
      if (method === 'fs.writeTextFile') return { bytesWritten: 5 }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    render(<FileExplorer root={ROOT} />)
    await screen.findByRole('treeitem', { name: /^README\.md/ })
    invokeMock.mockClear()

    await user.click(screen.getByRole('button', { name: /^README\.md/ }))
    const buffer = await screen.findByRole('textbox', { name: 'File contents' })
    await waitFor(() => expect(buffer).toHaveValue('saved version'))
    expect(invokeMock).toHaveBeenCalledWith('fs.readTextFile', { path: `${ROOT}\\README.md` })

    await user.type(buffer, '!')

    // Saving writes through the jailed RPC and re-lists the tree.
    invokeMock.mockClear()
    invokeMock.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'fs.list') {
        const path = (params as { path: string }).path
        if (path === ROOT) return structuredClone(ROOT_ENTRIES)
        throw new Error('path does not exist')
      }
      return { bytesWritten: 6 }
    })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('fs.writeTextFile', {
        path: `${ROOT}\\README.md`,
        content: 'saved version!',
      }),
    )
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs.list', { path: ROOT }))
  })

  it('file rows drag with a workspace-relative mention payload', async () => {
    render(<FileExplorer root={ROOT} />)
    await screen.findByRole('treeitem', { name: /^README\.md/ })

    const setData = vi.fn()
    fireEvent.dragStart(screen.getByRole('button', { name: /README\.md/ }), {
      dataTransfer: { setData, effectAllowed: '' },
    })

    expect(setData).toHaveBeenCalledWith(FILE_MIME, 'README.md')
  })

  it('nested file rows carry their path below the root', async () => {
    const user = userEvent.setup()
    render(<FileExplorer root={ROOT} />)
    await screen.findByRole('treeitem', { name: /^README\.md/ })
    await user.click(screen.getByRole('button', { name: 'src' }))
    await screen.findByRole('treeitem', { name: /^main\.ts/ })

    const setData = vi.fn()
    fireEvent.dragStart(screen.getByRole('button', { name: /main\.ts/ }), {
      dataTransfer: { setData, effectAllowed: '' },
    })

    expect(setData).toHaveBeenCalledWith(FILE_MIME, 'src\\main.ts')
  })
})
