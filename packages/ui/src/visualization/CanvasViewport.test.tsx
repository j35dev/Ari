import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewport, clampZoom } from './CanvasViewport'

function pointer(target: Element, type: string, x: number, y: number, pointerType = 'mouse'): void {
  const event = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } })
  fireEvent(target, event)
}
function canvas() {
  const result = render(
    <CanvasViewport width={1000} height={700} label="Flow">
      <svg />
    </CanvasViewport>,
  )
  const viewport = screen.getByRole('region', { name: 'Flow canvas' })
  Object.defineProperties(viewport, { clientWidth: { value: 500 }, clientHeight: { value: 320 } })
  return { ...result, viewport }
}
describe('diagram canvas controls', () => {
  it('zooms around the current view, then fits both dimensions and resets scroll', () => {
    const { viewport } = canvas()
    viewport.scrollLeft = 100
    viewport.scrollTop = 20
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(Number(viewport.dataset['zoom'])).toBe(1.25)
    expect(viewport.scrollLeft).toBeCloseTo(181.5)
    expect(viewport.scrollTop).toBeCloseTo(59)
    fireEvent.click(screen.getByRole('button', { name: 'Fit diagram to view' }))
    const zoom = Number(viewport.dataset['zoom'])
    expect(zoom * 1000 + 48).toBeLessThanOrEqual(500)
    expect(zoom * 700 + 48).toBeLessThanOrEqual(320)
    expect(viewport.scrollLeft).toBe(0)
    expect(viewport.scrollTop).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Reset diagram zoom' }))
    expect(viewport.dataset['zoom']).toBe('1')
  })
  it('pans in both axes by dragging or using arrow keys, and leaves touch to native scrolling', () => {
    const { viewport } = canvas()
    viewport.scrollLeft = 150
    viewport.scrollTop = 80
    pointer(viewport, 'pointerdown', 200, 120)
    pointer(viewport, 'pointermove', 100, 40)
    expect(viewport.scrollLeft).toBe(250)
    expect(viewport.scrollTop).toBe(160)
    pointer(viewport, 'pointerup', 100, 40)
    expect(viewport).not.toHaveAttribute('data-dragging')
    fireEvent.keyDown(viewport, { key: 'ArrowRight' })
    fireEvent.keyDown(viewport, { key: 'ArrowDown', shiftKey: true })
    expect(viewport.scrollLeft).toBe(306)
    expect(viewport.scrollTop).toBe(320)
    pointer(viewport, 'pointerdown', 100, 40, 'touch')
    expect(viewport).not.toHaveAttribute('data-dragging')
  })
  it('handles Ctrl-wheel zoom locally while preserving ordinary wheel input', () => {
    const { viewport } = canvas()
    const normal = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    fireEvent(viewport, normal)
    expect(normal.defaultPrevented).toBe(false)
    expect(viewport.dataset['zoom']).toBe('1')
    const zoom = new WheelEvent('wheel', {
      deltaY: -120,
      ctrlKey: true,
      clientX: 250,
      clientY: 160,
      bubbles: true,
      cancelable: true,
    })
    fireEvent(viewport, zoom)
    expect(zoom.defaultPrevented).toBe(true)
    expect(Number(viewport.dataset['zoom'])).toBeGreaterThan(1)
    expect(clampZoom(20)).toBe(3)
    expect(clampZoom(0)).toBe(0.01)
  })

  it('fits the longest supported flow in a narrow mobile viewport', () => {
    render(
      <CanvasViewport width={11_068} height={192} label="Long flow">
        <svg />
      </CanvasViewport>,
    )
    const viewport = screen.getByRole('region', { name: 'Long flow canvas' })
    Object.defineProperties(viewport, { clientWidth: { value: 270 }, clientHeight: { value: 310 } })
    fireEvent.click(screen.getByRole('button', { name: 'Fit diagram to view' }))
    const zoom = Number(viewport.dataset['zoom'])
    expect(zoom * 11_068 + 48).toBeLessThanOrEqual(270)
    expect(zoom * 192 + 48).toBeLessThanOrEqual(310)
  })
})
