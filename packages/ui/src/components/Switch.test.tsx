import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

afterEach(cleanup)

describe('Switch', () => {
  it('toggles aria-checked on click when uncontrolled', async () => {
    const user = userEvent.setup()
    render(<Switch />)
    const el = screen.getByRole('switch')
    expect(el).toHaveAttribute('aria-checked', 'false')
    await user.click(el)
    expect(el).toHaveAttribute('aria-checked', 'true')
    await user.click(el)
    expect(el).toHaveAttribute('aria-checked', 'false')
  })

  it('honors defaultChecked', () => {
    render(<Switch defaultChecked />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('reports changes and defers to the controlled value', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    const { rerender } = render(<Switch checked={false} onCheckedChange={onCheckedChange} />)
    const el = screen.getByRole('switch')
    await user.click(el)
    expect(onCheckedChange).toHaveBeenCalledWith(true)
    expect(el).toHaveAttribute('aria-checked', 'false')
    rerender(<Switch checked onCheckedChange={onCheckedChange} />)
    expect(el).toHaveAttribute('aria-checked', 'true')
  })
})
