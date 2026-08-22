import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStrip } from './AttachmentStrip'

// jsdom lacks the Blob URL store; stand in deterministic fakes.
let urlCounter = 0
const createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
const revokeObjectURL = vi.fn()

function png(name: string): File {
  return new File([new Uint8Array(4)], name, { type: 'image/png' })
}

describe('AttachmentStrip', () => {
  // Clear in beforeEach, not afterEach: RTL unmounts the previous test's tree
  // during its own cleanup, after afterEach hooks run, which would pollute
  // the next test's call history.
  beforeEach(() => {
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    urlCounter = 0
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
  })

  it('renders nothing when there are no images', () => {
    const { container } = render(<AttachmentStrip images={[]} onRemove={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('renders one thumbnail per image with its object URL preview', () => {
    render(<AttachmentStrip images={[png('a.png'), png('b.png')]} onRemove={vi.fn()} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByAltText('a.png')).toHaveAttribute('src', 'blob:mock-1')
    expect(screen.getByAltText('b.png')).toHaveAttribute('src', 'blob:mock-2')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('removes via the per-thumb button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<AttachmentStrip images={[png('a.png'), png('b.png')]} onRemove={onRemove} />)
    await user.click(screen.getByRole('button', { name: 'Remove b.png' }))
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('revokes every object URL on unmount', () => {
    const { unmount } = render(
      <AttachmentStrip images={[png('a.png'), png('b.png')]} onRemove={vi.fn()} />,
    )
    expect(revokeObjectURL).not.toHaveBeenCalled()
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('revokes the previous URLs when the image set changes', () => {
    const { rerender } = render(
      <AttachmentStrip images={[png('a.png'), png('b.png')]} onRemove={vi.fn()} />,
    )
    const kept = png('c.png')
    rerender(<AttachmentStrip images={[kept]} onRemove={vi.fn()} />)
    // The two URLs from the first set are revoked, one fresh URL is created.
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(createObjectURL).toHaveBeenCalledTimes(3)
  })
})
