import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton'

function stubClipboard() {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

describe('CopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the given text to the clipboard on click', async () => {
    const writeText = stubClipboard()
    render(<CopyButton text="hello world" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('hello world')
  })

  it('swaps to the check state for 1.2s after copying', async () => {
    stubClipboard()
    render(<CopyButton text="hello world" />)
    const button = screen.getByRole('button', { name: 'Copy' })
    expect(button).not.toHaveAttribute('data-copied')
    fireEvent.click(button)
    await act(async () => {})
    expect(button).toHaveAttribute('data-copied', 'true')
    act(() => {
      vi.advanceTimersByTime(1199)
    })
    expect(button).toHaveAttribute('data-copied', 'true')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(button).not.toHaveAttribute('data-copied')
  })
})
