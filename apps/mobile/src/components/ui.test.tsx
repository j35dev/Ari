// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BottomSheet } from './ui'

afterEach(cleanup)

function sheet(): { onClose: ReturnType<typeof vi.fn>; grip: HTMLElement } {
  const onClose = vi.fn()
  render(
    <BottomSheet title="Effort" onClose={onClose}>
      <button type="button">Low</button>
    </BottomSheet>,
  )
  return { onClose, grip: screen.getByTestId('sheet-grip') }
}
const drag = (grip: HTMLElement, distance: number): void => {
  fireEvent.touchStart(grip, { touches: [{ clientY: 100 }] })
  fireEvent.touchMove(grip, { touches: [{ clientY: 100 + distance }] })
  fireEvent.touchEnd(grip)
}

describe('bottom sheet', () => {
  it('closes when dragged well down by its grip', () => {
    const { onClose, grip } = sheet()
    drag(grip, 160)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stays open after a short drag, back where it was', () => {
    const { onClose, grip } = sheet()
    drag(grip, 30)
    expect(onClose).not.toHaveBeenCalled()
    const panel = screen
      .getByRole('dialog', { name: 'Effort' })
      .querySelector<HTMLElement>('.sheet-rise')
    expect(panel?.style.transform).toBe('')
  })

  it('still closes from its backdrop and its close button', () => {
    const { onClose } = sheet()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
