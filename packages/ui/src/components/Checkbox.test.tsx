import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { Checkbox } from './Checkbox'

afterEach(cleanup)

describe('Checkbox', () => {
  it('toggles the native input when the label is clicked', async () => {
    const user = userEvent.setup()
    render(<Checkbox>Include drafts</Checkbox>)
    const input = screen.getByRole('checkbox', { name: 'Include drafts' })
    expect(input).not.toBeChecked()
    await user.click(screen.getByText('Include drafts'))
    expect(input).toBeChecked()
  })

  it('reflects the indeterminate prop as a dash', () => {
    const { rerender } = render(<Checkbox indeterminate />)
    const input = screen.getByRole<HTMLInputElement>('checkbox')
    expect(input.indeterminate).toBe(true)
    expect(screen.getByTestId('checkbox-dash')).toBeInTheDocument()
    rerender(<Checkbox />)
    expect(input.indeterminate).toBe(false)
    expect(screen.queryByTestId('checkbox-dash')).not.toBeInTheDocument()
    expect(screen.getByTestId('checkbox-check')).toBeInTheDocument()
  })
})
