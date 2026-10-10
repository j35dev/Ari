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

  // jsdom lays nothing out, so this pins the rule that keeps the rail inside
  // its pane: dots sit in slots that give up height, with no fixed gap between.
  it('lets every slot shrink so a long session cannot outgrow the rail', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ key: String(i), text: `prompt ${i}` }))
    render(<MessageRail entries={many} activeKey="40" onJump={() => undefined} />)

    const rail = screen.getByRole('navigation', { name: 'Message timeline' })
    expect(rail.className).not.toMatch(/\bgap-/)
    const slots = screen.getAllByRole('button')
    expect(slots).toHaveLength(80)
    for (const slot of slots) expect(slot).toHaveClass('shrink', 'min-h-0')
  })

  it('keeps the active dot full size however tightly the rest are packed', () => {
    render(<MessageRail entries={entries} activeKey="4" onJump={() => undefined} />)

    expect(screen.getByLabelText(/second prompt/).firstElementChild).toHaveClass('h-1.5')
    expect(screen.getByLabelText(/first prompt/).firstElementChild).not.toHaveClass('h-1.5')
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
