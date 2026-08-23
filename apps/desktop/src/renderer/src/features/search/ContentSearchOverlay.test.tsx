import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ContentSearchOverlay, toAbsolutePath } from './ContentSearchOverlay'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

const ROOT = 'C:\\demo'

const MATCHES = [
  { path: 'src\\main.ts', line: 12, text: 'export const needle = true' },
  { path: 'README.md', line: 3, text: 'needle in docs' },
]

const clipboardWrite = vi.fn()

describe('toAbsolutePath', () => {
  it('joins the jail-relative hit onto the root with native separators', () => {
    expect(toAbsolutePath('C:\\demo', 'src\\main.ts')).toBe('C:\\demo\\src\\main.ts')
    expect(toAbsolutePath('/demo', 'src/main.ts')).toBe('/demo/src/main.ts')
    expect(toAbsolutePath('C:\\demo\\', 'a.ts')).toBe('C:\\demo\\a.ts')
  })
})

describe('ContentSearchOverlay', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    clipboardWrite.mockReset()
    clipboardWrite.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /** Result waits must outlive the 160ms debounce even on a loaded CI box. */
  const findHit = async (text: string | RegExp): Promise<HTMLElement> =>
    await screen.findByText(text, {}, { timeout: 15_000 })

  it('does not invoke the RPC while the query is empty', async () => {
    const onClose = vi.fn()
    render(<ContentSearchOverlay open onClose={onClose} root={ROOT} />)
    expect(await findHit(/Type to search across/)).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Search project files'), '  ')
    await new Promise((r) => setTimeout(r, 300))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('debounces the query into one search.content invocation and lists hits', async () => {
    invokeMock.mockResolvedValue(structuredClone(MATCHES))
    render(<ContentSearchOverlay open onClose={vi.fn()} root={ROOT} />)

    await userEvent.type(screen.getByLabelText('Search project files'), 'needle')
    expect(invokeMock).not.toHaveBeenCalled()

    expect(await findHit('export const needle = true')).toBeInTheDocument()
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('search.content', { path: ROOT, query: 'needle' })
    })
    // One debounced call for six keystrokes, not six calls.
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('src\\main.ts')
    expect(screen.getByText('2 hits')).toBeInTheDocument()
  }, 30_000)

  it('copies absolute-path:line and closes when a hit is chosen', async () => {
    const onClose = vi.fn()
    invokeMock.mockResolvedValue(structuredClone(MATCHES))
    render(<ContentSearchOverlay open onClose={onClose} root={ROOT} />)

    await userEvent.type(screen.getByLabelText('Search project files'), 'needle')
    await findHit('needle in docs')
    await userEvent.click(screen.getByRole('option', { name: /README\.md/ }))
    expect(clipboardWrite).toHaveBeenCalledWith(`C:\\demo\\README.md:3`)
    expect(onClose).toHaveBeenCalledOnce()
  }, 30_000)

  it('keyboard: ArrowDown moves the highlight, Enter copies the active hit', async () => {
    const onClose = vi.fn()
    invokeMock.mockResolvedValue(structuredClone(MATCHES))
    render(<ContentSearchOverlay open onClose={onClose} root={ROOT} />)

    const input = screen.getByLabelText('Search project files')
    await userEvent.type(input, 'needle')
    await findHit('export const needle = true')

    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('README.md')

    await userEvent.keyboard('{Enter}')
    expect(clipboardWrite).toHaveBeenCalledWith(`C:\\demo\\README.md:3`)
    expect(onClose).toHaveBeenCalledOnce()
  }, 30_000)

  it('surfaces search failures without leaving the dialog stuck', async () => {
    invokeMock.mockRejectedValue(new Error('path does not exist'))
    render(<ContentSearchOverlay open onClose={vi.fn()} root={ROOT} />)

    await userEvent.type(screen.getByLabelText('Search project files'), 'x')
    expect(await screen.findByRole('alert')).toHaveTextContent('path does not exist')
  }, 30_000)

  it('renders a disabled hint when no project is registered', () => {
    render(<ContentSearchOverlay open onClose={vi.fn()} root={null} />)
    expect(screen.getByPlaceholderText('Add a project first')).toBeDisabled()
  })
})
