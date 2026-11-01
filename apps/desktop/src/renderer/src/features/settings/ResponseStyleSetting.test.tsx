import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { responseStyles } from '../transcript/response-styles'
import { ResponseStyleSetting } from './ResponseStyleSetting'

describe('ResponseStyleSetting', () => {
  it('keeps the current renderer selected by default and offers all four alternatives', async () => {
    render(<ResponseStyleSetting value="default" onChange={vi.fn()} />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Response style' })
    expect(trigger).toHaveTextContent('Default (current Ari)')
    await user.click(trigger)
    for (const item of responseStyles)
      expect(screen.getByRole('option', { name: item.label })).toBeInTheDocument()
  })

  it('saves through the callback, without optimistically claiming a failed save succeeded', async () => {
    const update = vi.fn().mockRejectedValue(new Error('disk write failed'))
    render(<ResponseStyleSetting value="default" onChange={update} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Response style' }))
    await user.click(screen.getByRole('option', { name: 'Fold' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('fold'))
    expect(await screen.findByRole('alert')).toHaveTextContent('previous style is unchanged')
    expect(screen.getByRole('button', { name: 'Response style' })).toHaveTextContent(
      'Default (current Ari)',
    )
    expect(screen.getByRole('button', { name: 'Response style' })).toBeEnabled()
  })

  it('serializes selections while a save is pending, then reflects the saved preference', async () => {
    let resolve!: () => void
    const update = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const { rerender } = render(<ResponseStyleSetting value="default" onChange={update} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Response style' }))
    await user.click(screen.getByRole('option', { name: 'Signal' }))
    expect(screen.getByRole('button', { name: 'Response style' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Saving response style')
    await act(async () => resolve())
    rerender(<ResponseStyleSetting value="signal" onChange={update} />)
    expect(screen.getByRole('button', { name: 'Response style' })).toHaveTextContent('Signal')
    expect(screen.getByRole('button', { name: 'Response style' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Response style' })).toHaveFocus()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('supports the existing Select keyboard navigation', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    render(<ResponseStyleSetting value="default" onChange={update} />)
    const user = userEvent.setup()
    screen.getByRole('button', { name: 'Response style' }).focus()
    await user.keyboard('{Enter}{End}{Enter}')
    expect(update).toHaveBeenCalledWith('signal')
  })

  it('does not write when reselecting the current value', async () => {
    const update = vi.fn()
    render(<ResponseStyleSetting value="flow" onChange={update} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Response style' }))
    await user.click(screen.getByRole('option', { name: 'Flow' }))
    expect(update).not.toHaveBeenCalled()
  })
})
