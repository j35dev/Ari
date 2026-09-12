import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SplitView } from './SplitView'
import {
  assignSession,
  initialLayout,
  setRatio,
  splitPane,
  toggleZoom,
  type IdFactory,
  type SplitLayout,
} from './split-layout'

/** Deterministic ids, so a fixture can name `pane1` / `pane2` and `split1`. */
function counter(): IdFactory {
  const seen: Record<'pane' | 'split', number> = { pane: 0, split: 0 }
  return (kind) => `${kind}${++seen[kind]}`
}

/** One pane, showing `sA`. */
function solo(): SplitLayout {
  return assignSession(initialLayout(counter()), 'pane1', 'sA')
}

/** `pane1` showing `sA` beside a blank `pane2`, which has the focus. */
function pair(): SplitLayout {
  const newId = counter()
  return assignSession(splitPane(initialLayout(newId), 'pane1', 'right', newId), 'pane1', 'sA')
}

/** Both panes filled, focus on `pane2`. */
function filled(): SplitLayout {
  const newId = counter()
  const layout = splitPane(initialLayout(newId), 'pane1', 'right', newId)
  return assignSession(assignSession(layout, 'pane1', 'sA'), 'pane2', 'sB')
}

const TITLES: Record<string, string> = { sA: 'Alpha', sB: 'Beta' }

function renderSplit(layout: SplitLayout) {
  const props = {
    titleOf: (sessionId: string) => TITLES[sessionId] ?? null,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    renderSession: (sessionId: string, paneId: string) => (
      <div data-testid={`session-${sessionId}`} data-pane={paneId} />
    ),
  }
  render(<SplitView layout={layout} {...props} />)
  return props
}

describe('SplitView', () => {
  it('renders a lone pane as the bare session view, with no chrome of its own', () => {
    renderSplit(solo())

    expect(screen.getByTestId('session-sA')).toHaveAttribute('data-pane', 'pane1')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Close / })).not.toBeInTheDocument()
  })

  it('frames every pane once there is more than one, titled by its session', () => {
    renderSplit(filled())

    expect(screen.getByRole('region', { name: 'Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.getByTestId('session-sB')).toHaveAttribute('data-pane', 'pane2')
  })

  it('gives the accent treatment to the focused pane alone', () => {
    renderSplit(filled())

    // `filled()` leaves focus on the right-hand pane.
    expect(screen.getByRole('region', { name: 'Beta' })).toHaveClass('border-accent/40')
    expect(screen.getByRole('region', { name: 'Alpha' })).toHaveClass('border-border/60')
  })

  it('takes focus from a pointer press or a keyboard landing inside a pane', () => {
    const { onFocus } = renderSplit(filled())

    fireEvent.pointerDown(screen.getByTestId('session-sA'))
    expect(onFocus).toHaveBeenCalledWith('pane1')

    fireEvent.focusIn(screen.getByTestId('session-sA'))
    expect(onFocus).toHaveBeenCalledTimes(2)
  })

  it('closes the pane whose × was pressed', () => {
    const { onClose } = renderSplit(filled())

    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha' }))
    expect(onClose).toHaveBeenCalledWith('pane1')
  })

  it('offers a blank pane the way in: a session dropped in from the sidebar', () => {
    renderSplit(pair())

    expect(screen.getByRole('region', { name: 'Empty pane' })).toBeInTheDocument()
    expect(screen.getByText('No session in this pane')).toBeInTheDocument()
  })

  it('lays a split out at its ratio, leading child first', () => {
    renderSplit(setRatio(filled(), 'split1', 0.3))

    const leading = screen.getByRole('region', { name: 'Alpha' }).parentElement
    expect(leading?.style.flex).toBe('0 1 30%')
    expect(screen.getByTestId('session-sB')).toBeInTheDocument()
  })

  it('shows only the zoomed pane, so the others are off screen not gone', () => {
    renderSplit(toggleZoom(filled()))

    expect(screen.getByRole('region', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.queryByTestId('session-sA')).not.toBeInTheDocument()
  })
})
