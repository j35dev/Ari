import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackBounds, type Bounds } from './bounds-sync'

/** Frames run only when the test says so, so each one can move the target first. */
function manualFrames(): { step: (count?: number) => void; pending: () => number } {
  let queue: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    queue.push(callback)
    return queue.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    queue = []
  })
  return {
    step: (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        const due = queue
        queue = []
        for (const callback of due) callback(performance.now())
      }
    },
    pending: () => queue.length,
  }
}

/** Collects every observer so a test can play a neighbour resizing. */
function capturedResizeObservers(): { fire: () => void; observed: () => Element[] } {
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = []
  class Recording {
    readonly entry: { callback: ResizeObserverCallback; targets: Element[] }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] }
      observers.push(this.entry)
    }
    observe(target: Element): void {
      this.entry.targets.push(target)
    }
    disconnect(): void {
      this.entry.targets = []
    }
  }
  vi.stubGlobal('ResizeObserver', Recording)
  return {
    fire: () => {
      for (const { callback } of observers) callback([], {} as ResizeObserver)
    },
    observed: () => observers.flatMap((observer) => observer.targets),
  }
}

describe('trackBounds', () => {
  let rect: { x: number; y: number; width: number; height: number }
  let host: HTMLElement
  let sidebar: HTMLElement
  let animations: Animation[]

  beforeEach(() => {
    rect = { x: 800.4, y: 100, width: 400, height: 600 }
    const row = document.createElement('div')
    sidebar = document.createElement('aside')
    const rail = document.createElement('aside')
    host = document.createElement('div')
    rail.append(host)
    row.append(sidebar, rail)
    document.body.append(row)
    host.getBoundingClientRect = () => ({ ...rect }) as DOMRect
    animations = []
    Element.prototype.getAnimations = () => animations
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('reports the rounded rect at once and again only when it changes', () => {
    const frames = manualFrames()
    const seen: Bounds[] = []
    trackBounds(host, (bounds) => seen.push(bounds))
    expect(seen).toEqual([{ x: 800, y: 100, width: 400, height: 600 }])

    frames.step(3)
    expect(seen).toHaveLength(1)
    rect.x = 640
    frames.step()
    expect(seen.at(-1)).toEqual({ x: 640, y: 100, width: 400, height: 600 })
    expect(seen).toHaveLength(2)
  })

  it('follows a move the host never resized for, from a neighbour or the window', () => {
    const frames = manualFrames()
    const resize = capturedResizeObservers()
    const seen: Bounds[] = []
    trackBounds(host, (bounds) => seen.push(bounds))
    expect(resize.observed()).toContain(sidebar)
    frames.step(20)
    expect(frames.pending()).toBe(0)

    // The sidebar collapses: its box resizes, the rail only slides left.
    resize.fire()
    for (const x of [700, 600, 500]) {
      rect.x = x
      frames.step()
    }
    expect(seen.map((bounds) => bounds.x)).toEqual([800, 700, 600, 500])
    frames.step(20)
    expect(frames.pending()).toBe(0)

    window.dispatchEvent(new Event('resize'))
    rect.x = 900
    frames.step()
    expect(seen.at(-1)?.x).toBe(900)
  })

  it('keeps watching while an ancestor animates, then settles on its final frame', () => {
    const frames = manualFrames()
    const seen: Bounds[] = []
    // The rail's slide-in: the rect holds still for a while before it moves.
    animations = [
      {
        playState: 'running',
        effect: { getComputedTiming: () => ({ endTime: 220 }) },
      } as unknown as Animation,
    ]
    trackBounds(host, (bounds) => seen.push(bounds))
    frames.step(30)
    expect(frames.pending()).toBe(1)

    rect.x = 788
    animations = []
    frames.step(20)
    expect(seen.at(-1)?.x).toBe(788)
    expect(frames.pending()).toBe(0)
  })

  it('ignores endless animations, which would never let it settle', () => {
    const frames = manualFrames()
    animations = [
      {
        playState: 'running',
        effect: { getComputedTiming: () => ({ endTime: Infinity }) },
      } as unknown as Animation,
    ]
    trackBounds(host, () => undefined)
    frames.step(20)
    expect(frames.pending()).toBe(0)
  })

  it('stops reporting once disposed', () => {
    const frames = manualFrames()
    const onChange = vi.fn()
    const stop = trackBounds(host, onChange)
    stop()
    rect.x = 10
    window.dispatchEvent(new Event('resize'))
    frames.step(5)
    expect(onChange).toHaveBeenCalledOnce()
  })
})
