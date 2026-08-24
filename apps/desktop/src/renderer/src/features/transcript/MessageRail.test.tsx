import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MessageRail, type MessageRailEntry } from './MessageRail'

const entries: MessageRailEntry[] = [
  { key: '0', text: 'first prompt' },
  { key: '4', text: 'second prompt' },
  { key: '9', text: 'third prompt' },
]

describe('MessageRail', () => {
  it('stays hidden until two prompts exist', () => {
    const { container } = render(
      <MessageRail entries={entries.slice(0, 1)} activeKey={null} onJump={() => undefined} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one dot per user message with previews and active state', () => {
    render(<MessageRail entries={entries} activeKey="4" onJump={() => undefined} />)

    for (const entry of entries) {
      expect(screen.getByLabelText(new RegExp(`Jump to message: ${entry.text}`))).toBeInTheDocument()
    }
    expect(screen.getByLabelText(/second prompt/)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByLabelText(/first prompt/)).not.toHaveAttribute('aria-current')
  })

  it('jumps on click and previews the prompt on hover', async () => {
    const onJump = vi.fn()
    const user = userEvent.setup()
    render(<MessageRail entries={entries} activeKey={null} onJump={onJump} />)

    await user.click(screen.getByLabelText(/third prompt/))
    expect(onJump).toHaveBeenCalledWith('9')

    fireEvent.mouseEnter(screen.getByLabelText(/second prompt/))
    expect(screen.getByRole('tooltip')).toHaveTextContent('second prompt')
  })
})
