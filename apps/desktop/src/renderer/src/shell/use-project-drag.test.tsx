import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionsUnderProjects, type SidebarProject } from './Sidebar'

const HOUR = 60 * 60 * 1000

function session(id: string, projectId: string): SessionSummary {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    updatedAt: Date.now() - HOUR,
    messageCount: 1,
  }
}

const projects: SidebarProject[] = [
  { id: 'proj-1', name: 'Alpha', path: '/code/alpha', status: 'ok' },
  { id: 'proj-2', name: 'Beta', path: '/code/beta', status: 'ok' },
  { id: 'proj-3', name: 'Gamma', path: '/code/gamma', status: 'ok' },
]

interface Geometry {
  top: number
  height: number
  left?: number
  right?: number
}

/**
 * jsdom lays nothing out, so the rows report stubbed geometry through the
 * element protocol the hook measures: `data-ari-project-row` rows plus the
 * sidebar's scroll container. Layout tops are derived from the *current* DOM
 * order and per-row heights, so a committed reorder moves the rows exactly
 * the way a real browser would.
 */
let geometry: Map<Element, Geometry>

const ROW_HEIGHTS: Record<string, number> = { 'proj-1': 60, 'proj-2': 80, 'proj-3': 40 }

/** Layout top of a row: sum of the heights of the rows above it in DOM order. */
function layoutTopOf(el: Element): number {
  let acc = 0
  const parent = el.parentElement
  if (parent !== null)
    for (const sib of Array.from(parent.children)) {
      if (sib === el) break
      if ((sib as Element).hasAttribute?.('data-ari-project-row'))
        acc += ROW_HEIGHTS[sib.getAttribute('data-ari-project-row') ?? ''] ?? 0
    }
  return acc
}

/** The inline translateY of an element (0 when untransformed). */
function transformOffsetOf(el: Element): number {
  const style = (el as HTMLElement).style
  const t = style?.transform
  if (!t || t === 'none') return 0
  const y = t.match(/translateY\(([^)]+)\)/)
  if (y) return parseFloat(y[1] ?? '0')
  const vec = t.match(/translate3d\(([^)]+)\)/)
  if (vec !== null && vec[1] !== undefined) return parseFloat(vec[1].split(',')[1] ?? '0')
  const mat = t.match(/matrix\(([^)]+)\)/)
  if (mat !== null && mat[1] !== undefined) return parseFloat(mat[1].split(',')[5] ?? '0')
  return 0
}

function patchGeometry(): void {
  const rows = [...document.querySelectorAll('[data-ari-project-row]')]
  rows.forEach((el) => {
    if (!geometry.has(el))
      geometry.set(el, { top: layoutTopOf(el), height: 0, left: 10, right: 250 })
  })
  const scroller = document.querySelector('nav[aria-label="Sessions"]')
  if (scroller !== null) geometry.set(scroller, { top: -200, height: 1200, left: 0, right: 280 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const geo = geometry.get(this) ?? { top: 0, height: 0, left: 0, right: 0 }
    const isRow = (this as Element).hasAttribute?.('data-ari-project-row') === true
    const width = (geo.right ?? 0) - (geo.left ?? 0)
    const height = isRow
      ? (ROW_HEIGHTS[this.getAttribute('data-ari-project-row') ?? ''] ?? 0)
      : geo.height
    const top = (isRow ? layoutTopOf(this) : geo.top) + transformOffsetOf(this)
    return {
      top,
      left: geo.left ?? 0,
      bottom: top + height,
      right: (geo.left ?? 0) + width,
      width,
      height,
      x: geo.left ?? 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  })
}

function renderProjectSidebar(onReorderProject: (id: string, beforeId: string | null) => void) {
  const utils = render(
    <SessionsUnderProjects
      sessions={projects.flatMap((p) => [session(`s-${p.id}`, p.id)])}
      projects={projects}
      activeSessionId={null}
      onSelect={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onToggleArchive={() => {}}
      onReorderProject={onReorderProject}
    />,
  )
  patchGeometry()
  return utils
}

const row = (name: string): HTMLElement =>
  screen.getByText(name).closest('[data-ari-project-row]') as HTMLElement

const headerOf = (name: string): HTMLElement =>
  screen.getByText(name).closest('button') as HTMLElement

// jsdom's PointerEvent supports the geometry/`buttons` init fields, and the
// hook listens natively on `window`, so the tests dispatch real pointer
// events inside `act` instead of relying on `fireEvent`'s event factory.
const pointer = (
  type: string,
  target: EventTarget,
  init: { clientX?: number; clientY?: number; buttons?: number },
): void => {
  act(() => {
    target.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        clientX: init.clientX ?? 100,
        clientY: init.clientY ?? 0,
        button: 0,
        buttons: init.buttons ?? 0,
        pointerId: 1,
      }),
    )
  })
}

const press = (name: string, y: number): void => {
  pointer('pointerdown', headerOf(name), { clientX: 100, clientY: y, buttons: 1 })
}
const move = (y: number, x = 100): void =>
  pointer('pointermove', window, { clientX: x, clientY: y, buttons: 1 })
const release = (y: number, x = 100): void =>
  pointer('pointerup', window, { clientX: x, clientY: y, buttons: 0 })
const pointercancel = (): void =>
  pointer('pointercancel', window, { clientX: 100, clientY: 0, buttons: 0 })

/** Press a header, travel the given pointer path (y positions in px), release. */
function drag(name: string, path: number[]) {
  press(name, (geometry.get(row(name))?.top ?? 0) + 20)
  for (const y of path) move(y)
  release(path[path.length - 1] ?? 0)
}

describe('project group drag reorder (regression: stable target, single commit)', () => {
  beforeEach(() => {
    localStorage.clear()
    geometry = new Map()
    vi.restoreAllMocks()
  })

  it('moves a group down across two rows with one commit that lands where the target indicated', () => {
    // Rows: Alpha 0..60, Beta 60..140, Gamma 140..180 (midpoints 30, 100, 160).
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    drag('Alpha', [40, 80, 120, 165, 175])

    expect(onReorderProject).toHaveBeenCalledTimes(1)
    expect(onReorderProject).toHaveBeenCalledWith('proj-1', null)
    // The drag session is over: no target bar lingers.
    expect(document.querySelector('[data-ari-project-row] .bg-accent')).toBeNull()
  })

  it('moves a group up to the top with the row it slots before', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    // Gamma pressed at y=160, swept up past Beta's and Alpha's midpoints.
    drag('Gamma', [160, 120, 60, 20])
    expect(onReorderProject).toHaveBeenCalledTimes(1)
    expect(onReorderProject).toHaveBeenCalledWith('proj-3', 'proj-1')
  })

  it('keeps the target bar on the row the drop will land in, updating as the pointer crosses midlines', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    press('Alpha', 20)
    // Still inside Alpha's home span (up to Beta's midpoint): no move yet, no bar.
    move(90)
    expect(document.querySelector('[data-ari-project-row] .bg-accent')).toBeNull()
    // Past Gamma's midpoint (160): Alpha lands last, on Gamma's bottom edge.
    move(170)
    expect(row('Gamma').querySelector('.bg-accent')).not.toBeNull()
    // Between Beta's and Gamma's midpoints: Alpha lands between them, bar on
    // Beta's bottom edge.
    move(110)
    expect(row('Beta').querySelector('.bg-accent')).not.toBeNull()
    release(110)
    expect(onReorderProject).toHaveBeenCalledTimes(1)
    expect(onReorderProject).toHaveBeenCalledWith('proj-1', 'proj-3')
  })

  it('never swaps the DOM order while the pointer is down: the pointer path cannot oscillate', () => {
    // The reported glitch: mid-drag re-renders made the ordering jump and the
    // dragged row chase its own threshold. Here the row's DOM position must
    // not move at all until the commit, no matter how the pointer wanders.
    const order = (): string[] =>
      [...document.querySelectorAll('[data-ari-project-row]')].map(
        (el) => el.getAttribute('data-ari-project-row') as string,
      )
    renderProjectSidebar(vi.fn())
    const initial = order()
    press('Beta', 80)
    for (const y of [120, 60, 140, 80, 10, 180, 100]) {
      move(y)
      expect(order()).toEqual(initial)
    }
    release(100) // inside Beta's home span (30..160): still no commit
  })

  it('persists nothing for a drop back onto the original slot', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    drag('Beta', [80, 120, 95, 70]) // wanders inside Beta's home span
    expect(onReorderProject).not.toHaveBeenCalled()
  })

  it('cancels on Escape with no commit', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    press('Alpha', 20)
    move(170)
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    })
    // The late release lands past Gamma's midpoint, but the session is gone.
    release(170)
    expect(onReorderProject).not.toHaveBeenCalled()
  })

  it('cancels on pointercancel without committing, even at a commit-valid position', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    press('Alpha', 20)
    move(170) // past Gamma's midpoint: a release here would commit
    pointercancel()
    // Even a stray release after the cancel must not resurrect the session.
    release(170)
    expect(onReorderProject).not.toHaveBeenCalled()
    expect(document.querySelector('[data-ari-project-row] .bg-accent')).toBeNull()
  })

  it('cancels when the pointer is released far outside the list', () => {
    const onReorderProject = vi.fn()
    renderProjectSidebar(onReorderProject)
    press('Alpha', 20)
    move(170)
    release(170, 2400)
    expect(onReorderProject).not.toHaveBeenCalled()
  })

  it('treats a press that does not travel as a click: the group still toggles', () => {
    renderProjectSidebar(vi.fn())
    const header = headerOf('Alpha')
    const before = header.getAttribute('aria-expanded')
    act(() => {
      header.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, button: 0, clientX: 100, clientY: 20 }),
      )
    })
    expect(header.getAttribute('aria-expanded')).not.toBe(before)
  })

  it('keeps a normal session click working after a drag session', () => {
    const onSelect = vi.fn()
    render(
      <SessionsUnderProjects
        sessions={projects.flatMap((p) => [session(`s-${p.id}`, p.id)])}
        projects={projects}
        activeSessionId={null}
        onSelect={onSelect}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchive={() => {}}
        onReorderProject={vi.fn()}
      />,
    )
    patchGeometry()
    drag('Alpha', [40, 170])
    act(() => {
      screen
        .getByText('Session s-proj-2')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }))
    })
    expect(onSelect).toHaveBeenCalledWith('s-proj-2')
  })
})
