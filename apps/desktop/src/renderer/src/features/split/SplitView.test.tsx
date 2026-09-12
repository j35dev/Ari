import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SplitView } from './SplitView'
import { PANE_MIME, SESSION_MIME } from './drag-split'
import {
  MAX_PANES,
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

/** `pane1` showing `sA` above a blank `pane2` — a single stacked split. */
function stackedPair(): SplitLayout {
  const newId = counter()
  const layout = splitPane(initialLayout(newId), 'pane1', 'below', newId)
  return assignSession(layout, 'pane1', 'sA')
}

/** Every pane the ceiling allows: a chain of six splits. */
function full(): SplitLayout {
  let layout = initialLayout(counter())
  for (let i = 1; i < MAX_PANES; i++) {
    layout = splitPane(layout, 'pane1', 'below')
  }
  return layout
}

const TITLES: Record<string, string> = { sA: 'Alpha', sB: 'Beta' }

function renderSplit(layout: SplitLayout) {
  const props = {
    titleOf: (sessionId: string) => TITLES[sessionId] ?? null,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onSplit: vi.fn(),
    onToggleZoom: vi.fn(),
    onResize: vi.fn(),
    onDropSession: vi.fn(),
    onDropPane: vi.fn(),
    renderSession: (sessionId: string, paneId: string) => (
      <div data-testid={`session-${sessionId}`} data-pane={paneId} />
    ),
  }
  render(<SplitView layout={layout} {...props} />)
  return props
}

/** Right-clicks a pane's body and returns the open menu. */
function openMenu(pane: string, target?: HTMLElement): HTMLElement {
  fireEvent.contextMenu(target ?? screen.getByTestId(pane), { clientX: 40, clientY: 40 })
  return screen.getByRole('menu')
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

describe('SplitView separators', () => {
  it('puts a separator between the two panes, reporting the split it moves', () => {
    renderSplit(filled())

    const separator = screen.getByRole('separator', { name: 'Resize Alpha and Beta' })
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuenow', '50')
    expect(separator).toHaveAttribute('aria-valuemin', '10')
    expect(separator).toHaveAttribute('aria-valuemax', '90')
    expect(separator).toHaveAttribute('title', 'Drag to resize · double-click to reset')
  })

  it('names the pane a blank one rather than leaving it out', () => {
    renderSplit(pair())

    expect(
      screen.getByRole('separator', { name: 'Resize Alpha and Empty pane' }),
    ).toBeInTheDocument()
  })

  it('turns a drag into that split’s new ratio', () => {
    const { onResize } = renderSplit(filled())
    const separator = screen.getByRole('separator', { name: 'Resize Alpha and Beta' })
    const container = separator.parentElement
    if (container === null) throw new Error('separator is not inside the split')
    // jsdom lays nothing out, so the box the ratio is measured against is stubbed.
    container.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 400, height: 300 }) as DOMRect
    // jsdom has no pointer capture either; the drag itself runs on window.
    separator.setPointerCapture = vi.fn()

    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((run) => {
      run(0)
      return 1
    })
    fireEvent.pointerDown(separator, { pointerId: 1, clientX: 300, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 10 })
    frame.mockRestore()

    // 320 sits 220px into a 400px box, so the leading pane takes 55% of it.
    expect(onResize).toHaveBeenCalledWith('split1', 0.55)
  })

  it('nudges with the arrow keys along the split’s own axis', () => {
    const { onResize } = renderSplit(filled())
    const separator = screen.getByRole('separator', { name: 'Resize Alpha and Beta' })

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenCalledWith('split1', 0.52)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(onResize).toHaveBeenCalledWith('split1', 0.48)
    // The cross axis belongs to whatever else is listening, not to this split.
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(onResize).toHaveBeenCalledTimes(2)
  })

  it('evens the split back up on a double-click', () => {
    const { onResize } = renderSplit(setRatio(filled(), 'split1', 0.2))

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize Alpha and Beta' }))
    expect(onResize).toHaveBeenCalledWith('split1', 0.5)
  })

  it('runs the other way for a stacked split', () => {
    const { onResize } = renderSplit(stackedPair())

    const separator = screen.getByRole('separator', { name: 'Resize Alpha and Empty pane' })
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent.keyDown(separator, { key: 'ArrowDown' })
    expect(onResize).toHaveBeenCalledWith('split1', 0.52)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenCalledTimes(1)
  })
})

describe('the pane menu', () => {
  it('opens on a right-click and drives the panel operations', () => {
    const { onSplit, onToggleZoom, onClose } = renderSplit(filled())

    const menu = openMenu('session-sA')
    expect(menu).toHaveAccessibleName('Alpha pane')
    expect(screen.getByRole('menuitem', { name: 'Split right' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Split down' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Zoom pane' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }))
    expect(onSplit).toHaveBeenCalledWith('pane1', 'below')

    openMenu('session-sB')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zoom pane' }))
    expect(onToggleZoom).toHaveBeenCalledWith('pane2')

    openMenu('session-sA')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close pane' }))
    expect(onClose).toHaveBeenCalledWith('pane1')
  })

  it('offers to undo a zoom that is in effect', () => {
    renderSplit(toggleZoom(filled()))

    openMenu('session-sB')
    expect(screen.getByRole('menuitem', { name: 'Unzoom pane' })).toBeInTheDocument()
  })

  it('leaves a right-click inside a field to the field', () => {
    const layout = filled()
    render(
      <SplitView
        layout={layout}
        titleOf={(id) => TITLES[id] ?? null}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onSplit={vi.fn()}
        onToggleZoom={vi.fn()}
        onResize={vi.fn()}
        onDropSession={vi.fn()}
        onDropPane={vi.fn()}
        renderSession={() => <textarea aria-label="Composer" />}
      />,
    )

    fireEvent.contextMenu(screen.getAllByLabelText('Composer')[0]!, { clientX: 40, clientY: 40 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    // The pane itself still opens one, so the guard is about the target alone.
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Alpha' }), {
      clientX: 40,
      clientY: 40,
    })
    expect(screen.getByRole('menu')).toHaveAccessibleName('Alpha pane')
  })

  it('disables the splits at the ceiling instead of hiding them', () => {
    renderSplit(full())

    fireEvent.contextMenu(screen.getAllByRole('region', { name: 'Empty pane' })[0]!, {
      clientX: 40,
      clientY: 40,
    })
    // The reason is part of the accessible name, so the entry explains itself.
    const splitRight = screen.getByRole('menuitem', { name: /^Split right:/ })
    expect(splitRight).toHaveAttribute('aria-disabled', 'true')
    expect(splitRight).toHaveAttribute('title', `A layout holds at most ${String(MAX_PANES)} panes`)
    expect(screen.getByRole('menuitem', { name: /^Split down:/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // Closing is still on offer: at the ceiling is exactly when a pane is freed.
    expect(screen.getByRole('menuitem', { name: 'Close pane' })).toHaveAttribute(
      'aria-disabled',
      'false',
    )
  })
})

describe('dropping onto a pane', () => {
  /** A pane's box, as the drop maths sees it once the browser has laid it out. */
  function measure(target: HTMLElement): void {
    target.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 200 }) as DOMRect
  }

  interface DragInit {
    clientX?: number
    clientY?: number
    /** The MIME the drag is carrying; omitted means an empty dataTransfer. */
    mime?: string
    value?: string
  }

  /**
   * A drag event that carries pointer coordinates. `fireEvent.dragOver` cannot:
   * jsdom has no `DragEvent`, so testing-library falls back to a bare `Event`,
   * which drops the coordinates and leaves the drop maths measuring `NaN`.
   */
  function fireDrag(
    type: 'dragover' | 'dragleave' | 'drop',
    target: HTMLElement,
    init: DragInit = {},
  ): void {
    const { mime, value = '', clientX = 0, clientY = 0 } = init
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      relatedTarget: document.body,
    })
    if (mime !== undefined) {
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          types: [mime],
          dropEffect: '',
          getData: (type: string) => (type === mime ? value : ''),
        },
      })
    }
    fireEvent(target, event)
  }

  const sessionDrag: DragInit = { mime: SESSION_MIME, value: 'sC' }
  const paneDrag: DragInit = { mime: PANE_MIME, value: 'pane1' }

  it('previews the half of a filled pane the session would take', () => {
    renderSplit(filled())
    const alpha = screen.getByRole('region', { name: 'Alpha' })
    measure(alpha)

    // Right of centre: the session takes the right-hand half.
    fireDrag('dragover', alpha, { clientX: 320, clientY: 100, ...sessionDrag })
    expect(alpha.querySelector('[data-drop-target]')).toHaveAttribute('data-drop-target', 'right')

    fireDrag('dragover', alpha, { clientX: 40, clientY: 100, ...sessionDrag })
    expect(alpha.querySelector('[data-drop-target]')).toHaveAttribute('data-drop-target', 'left')

    fireDrag('dragover', alpha, { clientX: 200, clientY: 20, ...sessionDrag })
    expect(alpha.querySelector('[data-drop-target]')).toHaveAttribute('data-drop-target', 'above')

    // Leaving the pane takes the preview with it.
    fireDrag('dragleave', alpha)
    expect(alpha.querySelector('[data-drop-target]')).toBeNull()
  })

  it('lights the whole of a blank pane, which has no side to choose', () => {
    const { onDropSession } = renderSplit(pair())
    const empty = screen.getByRole('region', { name: 'Empty pane' })
    measure(empty)

    fireDrag('dragover', empty, { clientX: 20, clientY: 20, ...sessionDrag })
    expect(empty.querySelector('[data-drop-target]')).toHaveAttribute('data-drop-target', 'fill')

    fireDrag('drop', empty, { clientX: 20, clientY: 20, ...sessionDrag })
    expect(onDropSession).toHaveBeenCalledWith('pane2', 'sC', 'right')
  })

  it('opens the dropped session on the edge it was let go on', () => {
    const { onDropSession } = renderSplit(filled())
    const beta = screen.getByRole('region', { name: 'Beta' })
    measure(beta)

    fireDrag('drop', beta, { clientX: 200, clientY: 190, ...sessionDrag })
    expect(onDropSession).toHaveBeenCalledWith('pane2', 'sC', 'below')
  })

  it('swaps two panes when one header is dropped on the other', () => {
    const { onDropPane, onDropSession } = renderSplit(filled())
    const beta = screen.getByRole('region', { name: 'Beta' })

    fireDrag('dragover', beta, { clientX: 20, clientY: 20, ...paneDrag })
    expect(beta.querySelector('[data-drop-target]')).toHaveAttribute('data-drop-target', 'fill')

    fireDrag('drop', beta, { clientX: 20, clientY: 20, ...paneDrag })
    expect(onDropPane).toHaveBeenCalledWith('pane2', 'pane1')
    expect(onDropSession).not.toHaveBeenCalled()
  })

  it('ignores a drag that is carrying neither a session nor a pane', () => {
    renderSplit(filled())
    const alpha = screen.getByRole('region', { name: 'Alpha' })

    fireDrag('dragover', alpha, { clientX: 320, clientY: 100, mime: 'Files' })
    expect(alpha.querySelector('[data-drop-target]')).toBeNull()
  })

  it('takes a drop on a lone pane, which is how the split starts', () => {
    const { onDropSession } = renderSplit(solo())
    const surface = screen.getByTestId('session-sA').parentElement
    if (surface === null) throw new Error('the session is not inside a drop surface')
    measure(surface)

    fireDrag('drop', surface, { clientX: 390, clientY: 100, ...sessionDrag })
    expect(onDropSession).toHaveBeenCalledWith('pane1', 'sC', 'right')
  })
})
