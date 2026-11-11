import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WidgetSnapshot } from '../../main/aria-widget/model'
import { Widget } from './Widget'

afterEach(cleanup)
const state: WidgetSnapshot = {
  id: 1,
  phase: 'listening',
  text: '',
  setup: false,
  theme: 'obsidian',
  reducedMotion: true,
  destination: 'dictation',
}

it.each([
  ['listening', 'recording', 'Dictating into this field'],
  ['transcribing', 'transcribing', 'Transcribing'],
  ['sent', 'inserted', 'Inserted'],
  ['error', 'error', 'Could not insert into this field'],
] as const)(
  'presents dictation %s without Aria branding or a sent state',
  (phase, visiblePhase, label) => {
    const { container } = render(
      <Widget
        state={{ ...state, phase, text: 'Could not insert into this field' }}
        level={0.1}
        onSetup={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(label)
    expect(container.querySelector('.dictation-indicator')).toHaveAttribute(
      'data-phase',
      visiblePhase,
    )
    expect(container.querySelector('.aria-pill, .ari-aria-mark, [data-phase="sent"]')).toBeNull()
    expect(container.textContent).not.toContain('Aria')
  },
)

it('hides an idle indicator and makes setup errors actionable', () => {
  const setup = vi.fn()
  const view = render(<Widget state={{ ...state, phase: 'hidden' }} level={0} onSetup={setup} />)
  expect(view.container).toBeEmptyDOMElement()
  view.rerender(
    <Widget
      state={{ ...state, phase: 'error', text: 'Set up speech to text', setup: true }}
      level={0}
      onSetup={setup}
    />,
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Set up speech to text. Open speech settings' }),
  )
  expect(setup).toHaveBeenCalledOnce()
})

it('retains the Aria pill for the Aria destination', () => {
  const { container } = render(
    <Widget
      state={{ ...state, destination: 'aria', phase: 'sent', text: 'Fix login' }}
      level={0}
      onSetup={vi.fn()}
    />,
  )
  expect(container.querySelector('.aria-pill')).toHaveAttribute('data-phase', 'sent')
  expect(container.querySelector('.ari-aria-mark')).not.toBeNull()
  expect(screen.getByLabelText('Sent')).toBeInTheDocument()
})
