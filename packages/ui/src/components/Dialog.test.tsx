import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange}>
      <Dialog.Trigger>Open</Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>Confirm</Dialog.Title>
        <Dialog.Description>Are you sure you want to continue?</Dialog.Description>
        <Dialog.Close>Cancel</Dialog.Close>
        <button>Extra</button>
      </Dialog.Content>
    </Dialog>
  )
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open' }))
  return screen.getByRole('dialog')
}

describe('Dialog', () => {
  it('opens via trigger with scrim and modal semantics', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const panel = await open(user)

    expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(panel.className).toContain('w-[min(480px,90vw)]')
    expect(panel.parentElement).toHaveStyle({
      background: 'color-mix(in oklab, black 55%, transparent)',
    })
  })

  it('resolves aria-labelledby to the rendered Dialog.Title id', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await open(user)

    const title = screen.getByText('Confirm')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-labelledby', title.id)
    expect(title.id).not.toBe('')
  })

  it('moves focus into the panel on open and restores it to the trigger on close', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await open(user)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('cycles Tab within the panel without escaping it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await open(user)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const extra = screen.getByRole('button', { name: 'Extra' })
    expect(cancel).toHaveFocus()

    await user.tab()
    expect(extra).toHaveFocus()

    await user.tab()
    expect(cancel).toHaveFocus()

    await user.tab({ shift: true })
    expect(extra).toHaveFocus()
  })

  it('closes via Dialog.Close and scrim pointerdown', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await open(user)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await open(user)
    // jsdom has no layout; dispatch a pointerdown that targets the scrim itself.
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement
    scrim.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('renders open with defaultOpen and focuses the panel', () => {
    render(
      <Dialog defaultOpen>
        <Dialog.Trigger>Open</Dialog.Trigger>
        <Dialog.Content>
          <Dialog.Title>Confirm</Dialog.Title>
          <Dialog.Close>Cancel</Dialog.Close>
        </Dialog.Content>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('stays closed when controlled with open={false} but reports intent', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <Dialog open={false} onOpenChange={onOpenChange}>
        <Dialog.Trigger>Open</Dialog.Trigger>
        <Dialog.Content>
          <Dialog.Title>Confirm</Dialog.Title>
          <Dialog.Close>Cancel</Dialog.Close>
        </Dialog.Content>
      </Dialog>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
