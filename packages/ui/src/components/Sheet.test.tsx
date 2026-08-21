import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SheetSide } from './Sheet'
import { Sheet } from './Sheet'

function Harness({
  side,
  onOpenChange,
}: {
  side: SheetSide
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Sheet onOpenChange={onOpenChange}>
      <Sheet.Trigger>Open</Sheet.Trigger>
      <Sheet.Content side={side}>
        <Sheet.Title>Details</Sheet.Title>
        <Sheet.Description>Side panel content</Sheet.Description>
        <Sheet.Close>Close</Sheet.Close>
      </Sheet.Content>
    </Sheet>
  )
}

describe('Sheet', () => {
  it.each<SheetSide>(['right', 'left', 'bottom'])(
    'renders the panel anchored to the %s edge',
    async (side) => {
      const user = userEvent.setup()
      render(<Harness side={side} />)
      await user.click(screen.getByRole('button', { name: 'Open' }))

      const panel = screen.getByRole('dialog')
      expect(panel).toHaveAttribute('aria-modal', 'true')
      if (side === 'right') {
        expect(panel).toHaveClass('top-0', 'right-0', 'h-full', 'rounded-l-lg')
        expect(panel.className).toContain('w-[min(420px,85vw)]')
      } else if (side === 'left') {
        expect(panel).toHaveClass('top-0', 'left-0', 'h-full', 'rounded-r-lg')
        expect(panel.className).toContain('w-[min(420px,85vw)]')
      } else {
        expect(panel).toHaveClass('bottom-0', 'left-0', 'w-full', 'rounded-t-lg')
        expect(panel.className).toContain('h-[min(420px,85vh)]')
      }
    },
  )

  it('opens via trigger, wires aria-labelledby, and focuses into the panel', async () => {
    const user = userEvent.setup()
    render(<Harness side="right" />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open' }))

    const title = screen.getByText('Details')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', title.id)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness side="left" onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('closes via Sheet.Close', async () => {
    const user = userEvent.setup()
    render(<Harness side="bottom" />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
