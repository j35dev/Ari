import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Popover } from './Popover'

function Harness({
  onOpenChange,
  onOutside,
}: {
  onOpenChange?: (open: boolean) => void
  onOutside?: () => void
}) {
  return (
    <div>
      <Popover onOpenChange={onOpenChange}>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content side="bottom" align="start">
          Panel body
        </Popover.Content>
      </Popover>
      <button onClick={onOutside}>Outside</button>
      <button aria-haspopup="menu" onClick={onOutside}>
        Other menu
      </button>
    </div>
  )
}

/** A menu whose own button toggles it, anchored through the `anchor` prop. */
function AnchoredMenu() {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setAnchor}>
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Chip
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content bare role="listbox" aria-label="Choices" className="w-52">
          <button onClick={() => setOpen(false)}>Choice</button>
        </Popover.Content>
      </Popover>
    </div>
  )
}

describe('Popover', () => {
  it('opens on trigger click and reflects aria-expanded', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Panel body')).not.toBeInTheDocument()

    await user.click(trigger)

    expect(screen.getByRole('dialog')).toHaveTextContent('Panel body')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('closes on pointerdown outside the popover', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Outside' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('swallows the click that dismissed it, except on another menu trigger', async () => {
    const user = userEvent.setup()
    const onOutside = vi.fn()
    render(<Harness onOutside={onOutside} />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onOutside).not.toHaveBeenCalled()

    // The swallow is one-shot: the next click goes through.
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    expect(onOutside).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Other menu' }))
    expect(onOutside).toHaveBeenCalledTimes(2)
  })

  it('anchors to an outside element whose own trigger keeps toggling it', async () => {
    const user = userEvent.setup()
    render(<AnchoredMenu />)
    const chip = screen.getByRole('button', { name: 'Chip' })
    await user.click(chip)
    const menu = screen.getByRole('listbox', { name: 'Choices' })
    expect(menu).toHaveClass('z-popover', 'w-52')
    expect(menu).not.toHaveClass('p-3')

    await user.click(chip)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    await user.click(screen.getByRole('button', { name: 'Choice' }))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('renders open by default and stays closed when controlled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <Popover defaultOpen>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content>Panel body</Popover.Content>
      </Popover>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    rerender(
      <Popover open={false} onOpenChange={onOpenChange}>
        <Popover.Trigger>Open</Popover.Trigger>
        <Popover.Content>Panel body</Popover.Content>
      </Popover>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenChange).toHaveBeenCalledWith(true)
    // The controlled close plays the exit animation before unmounting.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
