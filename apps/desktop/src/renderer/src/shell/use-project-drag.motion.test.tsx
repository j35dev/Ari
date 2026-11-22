import { act, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MotionValue } from 'motion/react'
import type * as Motion from 'motion/react'
import { useProjectDrag, type ProjectDrag } from './use-project-drag'
import { moveProjectInList } from '../features/session/session-nav'

// Control only the animation's completion. Geometry and pointer handling
// remain real hook logic; Chromium verifies the actual Motion renderer in
// testing/project-drag.html, without a mocked layout or animation clock.
const animation = vi.hoisted(() => ({
  playbacks: [] as {
    value: MotionValue<number>
    keyframes: number[]
    stop: ReturnType<typeof vi.fn>
    resolve: () => void
  }[],
}))
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof Motion>()
  return {
    ...actual,
    animate: (value: MotionValue<number>, keyframes: number[]) => {
      let resolve = (): void => {}
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      const stop = vi.fn()
      animation.playbacks.push({ value, keyframes, stop, resolve })
      return Object.assign(promise, { stop })
    },
  }
})

let current: ProjectDrag
let queued: Map<number, FrameRequestCallback>
const items = [
  { id: 'a', height: 60 },
  { id: 'b', height: 80 },
  { id: 'c', height: 40 },
]

function Harness({
  onCommit = () => {},
  scrollable = false,
}: {
  onCommit?: (id: string, beforeId: string | null) => void
  scrollable?: boolean
}) {
  const [order, setOrder] = useState(
    scrollable ? Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, height: 60 })) : items,
  )
  const refs = useRef(new Map<string, HTMLElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const drag = useProjectDrag({
    order: order.map((row) => row.id),
    scrollRef,
    rowAt: (id) => refs.current.get(id) ?? null,
    onCommit: (id, beforeId) => {
      onCommit(id, beforeId)
      setOrder((previous) => moveProjectInList(previous, id, beforeId))
    },
  })
  const offset = useSyncExternalStore(
    (notify) => drag.y.on('change', notify),
    () => drag.y.get(),
  )
  useLayoutEffect(() => {
    current = drag
    drag.settleAfterCommit()
  })
  useLayoutEffect(() => {
    const element = scrollRef.current!
    const contentHeight = scrollable ? 480 : 180
    const viewportHeight = scrollable ? 180 : 1200
    let scrollTop = 0
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: viewportHeight },
      // Reproduce transformed overflow enlarging the browser's scrollHeight.
      scrollHeight: { configurable: true, get: () => Math.max(contentHeight, drag.y.get() + 60) },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = Math.max(0, Math.min(next, element.scrollHeight - viewportHeight))
        },
      },
    })
    element.getBoundingClientRect = () => ({
      top: scrollable ? 0 : -200,
      bottom: scrollable ? 180 : 1000,
      left: 0,
      right: 280,
      width: 280,
      height: viewportHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }, [scrollable])
  return (
    <div data-scroller ref={scrollRef}>
      {order.map((row) => {
        const raised = drag.draggingId === row.id || drag.settlingId === row.id
        return (
          <div
            key={row.id}
            data-row={row.id}
            data-height={row.height}
            data-raised={raised}
            ref={(element) => {
              if (!element) {
                refs.current.delete(row.id)
                return
              }
              refs.current.set(row.id, element)
              element.getBoundingClientRect = () => {
                let layout = 0
                for (const sibling of element.parentElement!.children) {
                  if (sibling === element) break
                  layout += Number((sibling as HTMLElement).dataset.height)
                }
                const transform = parseFloat(
                  element.style.transform.match(/translateY\(([^)]+)\)/)?.[1] ?? '0',
                )
                const top = layout - (scrollRef.current?.scrollTop ?? 0) + transform
                return {
                  top,
                  bottom: top + row.height,
                  left: 10,
                  right: 250,
                  height: row.height,
                  width: 240,
                  x: 10,
                  y: top,
                  toJSON: () => ({}),
                }
              }
            }}
            style={{ transform: raised ? `translateY(${offset}px)` : 'none' }}
            onPointerDown={(event) => drag.start(row.id, event)}
          >
            {row.id}
          </div>
        )
      })}
    </div>
  )
}

const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!
const scroller = (): HTMLElement => document.querySelector<HTMLElement>('[data-scroller]')!
const pointer = (
  type: string,
  y: number,
  target: EventTarget = window,
  pointerId = 1,
  buttons?: number,
): void => {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId,
        button: 0,
        buttons: buttons ?? (type === 'pointerdown' || type === 'pointermove' ? 1 : 0),
        clientX: 100,
        clientY: y,
      }),
    )
  })
}
const press = (id: string, y = 20): void => pointer('pointerdown', y, row(id))
const move = (y: number): void => pointer('pointermove', y)
const release = (y: number): void => pointer('pointerup', y)
const cancel = (): void => pointer('pointercancel', 170)
const frame = (): void => {
  act(() => {
    const batch = [...queued]
    queued.clear()
    for (const [, callback] of batch) callback(performance.now())
  })
}
const complete = async (index = animation.playbacks.length - 1): Promise<void> => {
  const playback = animation.playbacks[index]!
  await act(async () => {
    playback.value.set(0)
    playback.resolve()
    await Promise.resolve()
  })
}

describe('project drag geometry and lifecycle', () => {
  beforeEach(() => {
    animation.playbacks.length = 0
    queued = new Map()
    let sequence = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++sequence
      queued.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queued.delete(id))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('includes the full press travel and handles multiple moves before the DOM renders', () => {
    render(<Harness />)
    press('a')
    move(23)
    expect(current.draggingId).toBeNull()
    move(32)
    expect(current.y.get()).toBe(12)
    act(() => {
      for (const y of [70, 140, 80, 175]) pointer('pointermove', y)
    })
    expect(current.y.get()).toBe(155)
    expect(row('a').getBoundingClientRect().top).toBe(155)
    expect(
      [...document.querySelectorAll('[data-row]')].map((element) => element.textContent),
    ).toEqual(['a', 'b', 'c'])
  })

  it('commits once on release and keeps the rebased transform attached before paint', async () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    press('a')
    move(40)
    move(170)
    release(175) // Release coordinates can differ from the last move.
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('a', null)
    expect(current.draggingId).toBeNull()
    expect(current.settlingId).toBe('a')
    expect(row('a').dataset.raised).toBe('true')
    expect(row('a').getBoundingClientRect().top).toBe(155)
    expect(current.y.get()).toBe(35)
    expect(animation.playbacks[0]?.keyframes).toEqual([35, 0])
    release(175)
    expect(onCommit).toHaveBeenCalledTimes(1)
    await complete()
    expect(current.settlingId).toBeNull()
    expect(row('a').getBoundingClientRect().top).toBe(120)
  })

  it.each(['pointercancel', 'Escape'])(
    'never commits on %s or a subsequent release',
    async (reason) => {
      const onCommit = vi.fn()
      render(<Harness onCommit={onCommit} />)
      press('a')
      move(175)
      if (reason === 'pointercancel') cancel()
      else
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        })
      release(175)
      expect(onCommit).not.toHaveBeenCalled()
      expect(current.targetIndex).toBeNull()
      expect(current.settlingId).toBe('a')
      await complete()
      expect(current.y.get()).toBe(0)
    },
  )

  it('ignores another pointer and cancels a drag when the pressed button is lost', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    press('a')
    move(175)
    pointer('pointermove', 50, window, 2)
    pointer('pointerup', 175, window, 2)
    pointer('pointercancel', 175, window, 2)
    expect(current.draggingId).toBe('a')
    expect(current.y.get()).toBe(155)
    pointer('pointermove', 175, window, 1, 0)
    release(175)
    expect(onCommit).not.toHaveBeenCalled()
    expect(current.draggingId).toBeNull()
  })

  it('continuously scrolls within the original content extent, pins the row and recomputes targets', () => {
    const onCommit = vi.fn()
    render(<Harness scrollable onCommit={onCommit} />)
    press('s1')
    move(160)
    expect(current.targetIndex).toBe(2)
    for (let i = 0; i < 40; i++) {
      frame()
      expect(row('s1').getBoundingClientRect().top).toBe(140)
    }
    expect(scroller().scrollTop).toBe(300)
    expect(current.targetIndex).toBe(7)
    expect(queued.size).toBe(0)
    release(160)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('s1', null)
    expect(row('s1').getBoundingClientRect().top).toBe(140)
    expect(current.y.get()).toBe(20)
  })

  it('stops queued scroll frames when leaving an edge, cancelling or unmounting', () => {
    const { unmount } = render(<Harness scrollable />)
    press('s1')
    move(160)
    frame()
    move(90)
    expect(queued.size).toBe(0)
    frame()
    expect(scroller().scrollTop).toBe(10)
    move(160)
    frame()
    cancel()
    expect(queued.size).toBe(0)
    const stopped = scroller().scrollTop
    frame()
    expect(scroller().scrollTop).toBe(stopped)
    press('s2', 80)
    move(160)
    frame()
    const playback = animation.playbacks[0]!
    expect(playback.stop).toHaveBeenCalledOnce()
    unmount()
    expect(queued.size).toBe(0)
  })

  it('continues from a settling row and ignores an interrupted animation completion', async () => {
    render(<Harness />)
    press('a')
    move(70)
    release(70)
    const interrupted = animation.playbacks[0]!
    expect(interrupted.keyframes).toEqual([50, 0])
    act(() => {
      interrupted.value.set(30)
    }) // Midway through a real glide.
    press('a', 50)
    move(62)
    expect(interrupted.stop).toHaveBeenCalledOnce()
    expect(current.y.get()).toBe(42)
    cancel()
    const next = animation.playbacks[1]!
    await act(async () => {
      interrupted.resolve()
      await Promise.resolve()
    })
    expect(current.settlingId).toBe('a')
    expect(next.keyframes).toEqual([42, 0])
    await complete()
    expect(current.settlingId).toBeNull()
  })

  it('resumes an interrupted settle when the new press never arms', async () => {
    render(<Harness />)
    press('a')
    move(70)
    release(70)
    press('a', 70)
    release(70)
    expect(animation.playbacks[0]?.stop).toHaveBeenCalledOnce()
    expect(animation.playbacks[1]?.keyframes).toEqual([50, 0])
    await complete()
    expect(current.settlingId).toBeNull()
  })

  it('grabs the visible settle position when the MotionValue is ahead of its DOM write', () => {
    render(<Harness />)
    press('a')
    move(70)
    release(70)
    act(() => {
      current.y.set(30)
    })
    row('a').style.transform = 'translateY(20px)'
    press('a', 40)
    expect(current.y.get()).toBe(20)
    move(52)
    expect(current.y.get()).toBe(32)
    expect(row('a').getBoundingClientRect().top).toBe(32)
  })

  it('lands the previous row when a different row is grabbed', () => {
    render(<Harness />)
    press('a')
    move(70)
    release(70)
    press('b', 80)
    move(92)
    expect(row('a').getBoundingClientRect().top).toBe(0)
    expect(current.draggingId).toBe('b')
    expect(current.y.get()).toBe(12)
  })

  it("preserves a neighbour's visible layout transform when starting another drag", () => {
    render(<Harness />)
    press('a')
    move(175)
    release(175)
    // c is animating up from its former slot after a moves to the tail.
    row('c').style.transform = 'translateY(20px)'
    press('c', 120)
    move(128)
    expect(row('c').getBoundingClientRect().top).toBe(108)
    expect(current.y.get()).toBe(28)
    expect(row('a').getBoundingClientRect().top).toBe(120)
  })

  it('reuses the untransformed scroll extent when grabbing a floating tail row', () => {
    render(<Harness scrollable />)
    press('s1')
    move(170)
    for (let i = 0; i < 31; i++) frame()
    cancel()
    expect(current.y.get()).toBe(450)
    expect(scroller().scrollHeight).toBe(510) // Temporarily inflated by the lift.
    press('s1', 170)
    move(178)
    for (let i = 0; i < 10; i++) frame()
    expect(scroller().scrollTop).toBe(300)
    expect(queued.size).toBe(0)
  })

  it.each(['pre-arm', 'active', 'settling'])(
    'unmount removes every registered listener and stops work during %s',
    async (phase) => {
      const adds = vi.spyOn(window, 'addEventListener')
      const removes = vi.spyOn(window, 'removeEventListener')
      const onCommit = vi.fn()
      const { unmount } = render(<Harness onCommit={onCommit} />)
      press('a')
      if (phase !== 'pre-arm') move(70)
      if (phase === 'settling') release(70)
      const registered = adds.mock.calls.filter(([type]) =>
        ['pointermove', 'pointerup', 'pointercancel', 'keydown'].includes(type),
      )
      unmount()
      for (const [type, listener] of registered)
        expect(removes.mock.calls.some((call) => call[0] === type && call[1] === listener)).toBe(
          true,
        )
      expect(queued.size).toBe(0)
      if (phase === 'settling') expect(animation.playbacks[0]?.stop).toHaveBeenCalledOnce()
      move(175)
      release(175)
      await act(async () => {
        for (const playback of animation.playbacks) playback.resolve()
        await Promise.resolve()
      })
      expect(onCommit).not.toHaveBeenCalled()
      adds.mockRestore()
      removes.mockRestore()
    },
  )

  it('disarms pre-arm presses on cancel, Escape and lost buttons', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    press('a')
    cancel()
    move(175)
    release(175)
    press('a')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    move(175)
    release(175)
    press('a')
    pointer('pointermove', 175, window, 1, 0)
    move(175)
    release(175)
    expect(onCommit).not.toHaveBeenCalled()
    expect(current.draggingId).toBeNull()
    expect(animation.playbacks).toHaveLength(0)
  })
})
