import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { Message } from '@ari/contracts/message'
import { NoticeNote } from './NoticeNote'
import { TranscriptView } from './TranscriptView'

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

afterEach(cleanup)

function user(id: string, text: string): Message {
  return {
    id,
    sessionId: 'sess_1',
    turnId: null,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: 1,
  }
}

describe('slash command messages in the transcript', () => {
  it('renders a sent command as a compact chip, keeping edit and copy', async () => {
    const onEditUserMessage = vi.fn()
    const { container } = render(
      createElement(TranscriptView, {
        sessionId: 'sess_1',
        messages: [user('m1', '/goal ship the beta'), user('m2', 'see /usr/bin')],
        onEditUserMessage,
      }),
    )
    const chip = container.querySelector('[data-slash-command="goal"]')
    expect(chip).toHaveTextContent('/goal ship the beta')
    expect(chip?.querySelector('.font-medium')).toHaveTextContent('/goal')
    // Prose that only contains a slash stays a bubble.
    expect(container.querySelectorAll('.ari-user-bubble')).toHaveLength(1)
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Edit message' })[0]!)
    expect(onEditUserMessage).toHaveBeenCalledWith('/goal ship the beta')
  })

  it('folds long arguments behind Show all', async () => {
    const long = `/review ${'check the parser and the lexer. '.repeat(12)}`
    const { container } = render(
      createElement(TranscriptView, { sessionId: 'sess_1', messages: [user('m1', long)] }),
    )
    const chip = container.querySelector('[data-slash-command="review"]')!
    expect(chip.textContent).toContain('…')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }))
    expect(chip.textContent).toContain(long.trim().slice(-30))
    expect(chip.className).toContain('max-w-[72%]')
  })
})

describe('NoticeNote', () => {
  it('shows a sentence in full', () => {
    render(<NoticeNote text="Goal cleared." />)
    expect(screen.getByRole('note')).toHaveTextContent('Goal cleared.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('folds long command output and keeps its line breaks', async () => {
    const output = Array.from({ length: 20 }, (_, i) => `| row ${i} | ${i * 10}k |`).join('\n')
    render(<NoticeNote text={output} />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('row 5')
    expect(note).not.toHaveTextContent('row 12')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }))
    expect(note).toHaveTextContent('row 19')
    expect(note.querySelector('.whitespace-pre-wrap')).not.toBeNull()
  })
})
