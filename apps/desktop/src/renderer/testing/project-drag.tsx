// Real Chromium layout and motion checks. Open testing/project-drag.html
// through project-drag-fixture.config.ts and click Run checks. No app IPC.
import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { motion } from 'motion/react'
import { transitions } from '@ari/ui/motion'
import { useProjectDrag } from '../src/shell/use-project-drag'
import { moveProjectInList } from '../src/features/session/session-nav'

const frames = async (count = 2): Promise<void> => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const commits: { list: string; id: string; beforeId: string | null }[] = []
const results: { name: string; passed: boolean; detail?: string }[] = []
const errors: string[] = []
const reads = new Map<string, () => unknown>()
const layouts: { list: string; id: string; top: number; y: number }[] = []
let reset: () => void = () => {}
let hide: () => void = () => {}
let running = false

// Track listener identities, rather than counting calls to removeEventListener.
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
const nativeAdd = window.addEventListener.bind(window)
const nativeRemove = window.removeEventListener.bind(window)
window.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
) => {
  if (['pointermove', 'pointerup', 'pointercancel', 'keydown'].includes(type)) {
    const registered = listeners.get(type) ?? new Set()
    registered.add(listener)
    listeners.set(type, registered)
  }
  nativeAdd(type, listener, options)
}) as typeof window.addEventListener
window.removeEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: EventListenerOptions | boolean,
) => {
  listeners.get(type)?.delete(listener)
  nativeRemove(type, listener, options)
}) as typeof window.removeEventListener
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

function List({ id, scrollable = false }: { id: string; scrollable?: boolean }) {
  const initial = scrollable
    ? Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, height: 60 }))
    : [
        { id: 'alpha', height: 60 },
        { id: 'beta', height: 80 },
        { id: 'gamma', height: 40 },
      ]
  const [order, setOrder] = useState(initial)
  const refs = useRef(new Map<string, HTMLElement>())
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useProjectDrag({
    order: order.map((row) => row.id),
    rowAt: (rowId) => refs.current.get(rowId) ?? null,
    scrollRef: scroller,
    onCommit: (rowId, beforeId) => {
      commits.push({ list: id, id: rowId, beforeId })
      setOrder((previous) => moveProjectInList(previous, rowId, beforeId))
    },
  })
  useLayoutEffect(() => {
    drag.settleAfterCommit()
    if (drag.settlingId) {
      const row = refs.current.get(drag.settlingId)
      if (row)
        layouts.push({
          list: id,
          id: drag.settlingId,
          top: row.getBoundingClientRect().top,
          y: drag.y.get(),
        })
    }
    reads.set(id, () => ({
      order: order.map((row) => row.id),
      dragging: drag.draggingId,
      settling: drag.settlingId,
      target: drag.targetIndex,
      y: drag.y.get(),
      scroll: scroller.current?.scrollTop,
      rows: [...refs.current].map(([rowId, row]) => ({
        id: rowId,
        top: row.getBoundingClientRect().top,
        transform: row.style.transform,
      })),
    }))
    return () => {
      reads.delete(id)
    }
  })
  return (
    <div
      id={id}
      className="list"
      ref={scroller}
      style={scrollable ? { height: 280, overflowY: 'auto' } : undefined}
    >
      {order.map((row) => {
        const raised = drag.draggingId === row.id || drag.settlingId === row.id
        return (
          <motion.div
            key={row.id}
            className="row"
            data-row={row.id}
            ref={(element) => {
              if (element) refs.current.set(row.id, element)
              else refs.current.delete(row.id)
            }}
            layout={drag.draggingId === null && drag.settlingId === null ? 'position' : false}
            transition={transitions.resort}
            style={{ height: row.height, y: raised ? drag.y : 0, zIndex: raised ? 10 : undefined }}
            onPointerDown={(event) => drag.start(row.id, event)}
          >
            {row.id}
          </motion.div>
        )
      })}
    </div>
  )
}

const row = (id: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!element) throw new Error(`Missing row ${id}`)
  return element
}
const top = (id: string): number => row(id).getBoundingClientRect().top
const scroller = (): HTMLElement => {
  const element = document.getElementById('scroll')
  if (!element) throw new Error('Missing scroller')
  return element
}
const pointer = (type: string, y: number, target: EventTarget = window, x = 50): void => {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      button: 0,
      buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
      clientX: x,
      clientY: y,
    }),
  )
}
const press = (id: string): number => {
  const y = top(id) + 20
  pointer('pointerdown', y, row(id))
  return y
}
const order = (id = 'main'): string =>
  [...document.querySelectorAll(`#${id} [data-row]`)]
    .map((element) => (element as HTMLElement).dataset.row)
    .join(',')
const listenerCount = (): number =>
  [...listeners.values()].reduce((total, registered) => total + registered.size, 0)
const expect = (passed: boolean, detail: string): void => {
  if (!passed) throw new Error(detail)
}
const near = (actual: number, expected: number): void =>
  expect(Math.abs(actual - expected) < 1.5, `got ${actual}, expected ${expected}`)
const fresh = async (): Promise<void> => {
  reset()
  await frames()
  commits.length = 0
  layouts.length = 0
}

async function runChecks(): Promise<void> {
  if (running) return
  running = true
  results.length = 0
  const check = async (name: string, test: () => Promise<void>): Promise<void> => {
    try {
      await fresh()
      await test()
      results.push({ name, passed: true })
    } catch (error) {
      results.push({ name, passed: false, detail: String(error) })
    }
  }
  await check(
    'Full press travel, rapid moves, stable DOM, single drop and pre-paint rebase',
    async () => {
      const start = top('alpha')
      const y = press('alpha')
      pointer('pointermove', y + 12)
      await frames()
      near(top('alpha'), start + 12)
      for (const delta of [45, 110, 70, 155]) pointer('pointermove', y + delta)
      await frames()
      near(top('alpha'), start + 155)
      expect(order() === 'alpha,beta,gamma', order())
      pointer('pointerup', y + 155)
      // React commits in a microtask; the fixture's layout effect records the
      // rebased rect synchronously, before any scheduled Motion render.
      await frames()
      expect(commits.length === 1 && order() === 'beta,gamma,alpha', JSON.stringify(commits))
      const first = layouts.find((layout) => layout.id === 'alpha')
      expect(first !== undefined, 'Settle binding missing')
      near(first?.top ?? NaN, start + 155)
      expect((first?.y ?? 0) > 20 && (first?.y ?? 0) < 50, JSON.stringify(first))
      let previous = start + 155
      for (let i = 0; i < 22; i++) {
        await frames(1)
        const position = top('alpha')
        expect(
          position >= start + 118.5 && position <= previous + 1.5,
          `Settle jumped from ${previous} to ${position}`,
        )
        previous = position
      }
      await pause(100)
      near(top('alpha'), start + 120)
      expect(row('alpha').style.transform === 'none', row('alpha').style.transform)
    },
  )
  await check('Pointercancel and late release never commit', async () => {
    const y = press('alpha')
    pointer('pointermove', y + 155)
    await frames()
    pointer('pointercancel', y + 155)
    pointer('pointerup', y + 155)
    await pause(300)
    expect(commits.length === 0 && order() === 'alpha,beta,gamma', JSON.stringify(commits))
    near(top('alpha'), top('beta') - 60)
    expect(listenerCount() === 0, `listeners: ${listenerCount()}`)
  })
  await check('Escape and out-of-list release cancel', async () => {
    let y = press('alpha')
    pointer('pointermove', y + 155)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    pointer('pointerup', y + 155)
    await pause(300)
    y = press('alpha')
    pointer('pointermove', y + 155)
    pointer('pointerup', y + 155, window, 1000)
    await pause(300)
    expect(commits.length === 0, JSON.stringify(commits))
  })
  await check(
    'Continuous bottom scroll is bounded, tracks the pointer and recomputes target',
    async () => {
      const start = top('s1')
      const y = press('s1')
      const edge = scroller().getBoundingClientRect().bottom - 18
      pointer('pointermove', edge)
      await frames()
      const initialTarget = (reads.get('scroll')?.() as { target: number }).target
      for (let i = 0; i < 28; i++) {
        await frames(1)
        near(top('s1'), edge - (y - start))
      }
      expect(scroller().scrollTop === 200, `scrollTop=${scroller().scrollTop}`)
      const lastTarget = (reads.get('scroll')?.() as { target: number }).target
      expect(lastTarget > initialTarget, `target ${initialTarget} -> ${lastTarget}`)
      await frames(8)
      expect(scroller().scrollTop === 200, 'Scroll chased transform overflow')
      pointer('pointerup', edge)
      await pause(350)
      expect(
        commits.length === 1 && commits[0]?.id === 's1' && commits[0].beforeId === null,
        JSON.stringify(commits),
      )
      expect(order('scroll').endsWith('s1'), order('scroll'))
      expect(listenerCount() === 0, `listeners: ${listenerCount()}`)
    },
  )
  await check('Continuous top scroll tracks pointer and lands first', async () => {
    scroller().scrollTop = 200
    const start = top('s8')
    const y = press('s8')
    const edge = scroller().getBoundingClientRect().top + 18
    pointer('pointermove', edge)
    for (let i = 0; i < 28; i++) {
      await frames(1)
      near(top('s8'), edge - (y - start))
    }
    expect(scroller().scrollTop === 0, `scrollTop=${scroller().scrollTop}`)
    pointer('pointerup', edge)
    await pause(350)
    expect(commits.length === 1 && commits[0]?.beforeId === 's1', JSON.stringify(commits))
  })
  await check('Leaving edge and cancellation stop queued scroll frames', async () => {
    press('s1')
    const bounds = scroller().getBoundingClientRect()
    pointer('pointermove', bounds.bottom - 18)
    await frames(3)
    pointer('pointermove', bounds.top + 140)
    const stopped = scroller().scrollTop
    await frames(5)
    expect(scroller().scrollTop === stopped && stopped > 0, `scrollTop=${scroller().scrollTop}`)
    pointer('pointermove', bounds.bottom - 18)
    await frames(2)
    pointer('pointercancel', bounds.bottom - 18)
    const cancelled = scroller().scrollTop
    await frames(5)
    expect(scroller().scrollTop === cancelled, 'Scrolled after cancellation')
    await pause(300)
    expect(commits.length === 0 && listenerCount() === 0, 'Cancel leaked work')
  })
  await check('Re-grabbing settling row preserves its visible position', async () => {
    let y = press('alpha')
    pointer('pointermove', y + 50)
    await frames()
    pointer('pointerup', y + 50)
    await pause(25)
    const floating = top('alpha')
    expect(floating > top('beta') - 60 + 2, 'Settle completed before grab')
    y = press('alpha')
    pointer('pointermove', y + 12)
    await frames()
    near(top('alpha'), floating + 12)
    pointer('pointercancel', y + 12)
    await pause(300)
    near(top('alpha'), top('beta') - 60)
    expect(commits.length === 0, 'Re-grab committed')
  })
  await check(
    'Pre-arm re-grab resumes settle; grabbing another row lands the old row',
    async () => {
      let y = press('alpha')
      pointer('pointermove', y + 50)
      await frames()
      pointer('pointerup', y + 50)
      await pause(25)
      y = press('alpha')
      pointer('pointerup', y)
      await pause(300)
      near(top('alpha'), top('beta') - 60)
      y = press('alpha')
      pointer('pointermove', y + 50)
      await frames()
      pointer('pointerup', y + 50)
      await pause(25)
      y = press('beta')
      pointer('pointermove', y + 8)
      await frames()
      near(top('alpha'), top('gamma') - 140)
      pointer('pointercancel', y + 8)
      await pause(300)
      expect(commits.length === 0, 'Settle interruption committed')
    },
  )
  await check('Pre-arm Escape and unmount remove listener identities', async () => {
    press('alpha')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    pointer('pointermove', 170)
    pointer('pointerup', 170)
    expect(listenerCount() === 0 && commits.length === 0, 'Escape leaked press')
    press('alpha')
    hide()
    await frames()
    pointer('pointermove', 170)
    pointer('pointerup', 170)
    expect(listenerCount() === 0 && commits.length === 0, 'Unmount leaked press')
  })
  await check('New drag after a committed reorder preserves the grabbed row position', async () => {
    for (const grabbed of ['alpha', 'gamma']) {
      await fresh()
      press('alpha')
      const destination = top('gamma') + 25
      pointer('pointermove', destination)
      await frames()
      pointer('pointerup', destination)
      await pause(25)
      expect(commits.length === 1, 'Initial reorder did not commit')
      const visibleTop = top(grabbed)
      const y = press(grabbed)
      pointer('pointermove', y + 8)
      await frames()
      expect(
        Math.abs(top(grabbed) - visibleTop - 8) < 1.5,
        JSON.stringify({ grabbed, visibleTop, top: top(grabbed), drag: reads.get('main')?.() }),
      )
      pointer('pointercancel', y + 8)
      await pause(300)
      expect(commits.length === 1 && listenerCount() === 0, 'Interrupted committed settle leaked')
    }
    await fresh()
    press('s1')
    const edge = scroller().getBoundingClientRect().bottom - 18
    pointer('pointermove', edge)
    await frames(28)
    pointer('pointerup', edge)
    await pause(25)
    const y = press('s1')
    pointer('pointermove', y + 8)
    await frames(8)
    expect(scroller().scrollTop === 200, 'Re-grab chased settling row overflow')
    pointer('pointercancel', y + 8)
    await pause(300)
  })
  await check(
    'Active scrolling unmount removes frames/listeners; settling unmount stops motion',
    async () => {
      press('s1')
      pointer('pointermove', scroller().getBoundingClientRect().bottom - 18)
      await frames(3)
      const element = scroller()
      hide()
      await frames()
      const stopped = element.scrollTop
      await frames(5)
      expect(element.scrollTop === stopped && listenerCount() === 0, 'Unmount leaked scroll')
      await fresh()
      const y = press('alpha')
      pointer('pointermove', y + 50)
      await frames()
      pointer('pointerup', y + 50)
      await pause(25)
      hide()
      await frames()
      await pause(300)
      expect(listenerCount() === 0 && errors.length === 0, JSON.stringify(errors))
    },
  )
  reset()
  await frames()
  running = false
}

function App() {
  const [generation, setGeneration] = useState(0)
  const [visible, setVisible] = useState(true)
  const [completed, setCompleted] = useState(0)
  reset = () => {
    setGeneration((value) => value + 1)
    setVisible(true)
  }
  hide = () => setVisible(false)
  return (
    <>
      {visible ? (
        <div key={generation}>
          <List id="main" />
          <List id="scroll" scrollable />
        </div>
      ) : null}
      <button
        onClick={() => {
          void runChecks()
            .catch((error: unknown) => {
              errors.push(String(error))
              running = false
            })
            .then(() => setCompleted((value) => value + 1))
        }}
      >
        Run checks
      </button>
      <button onClick={reset}>Reset fixture</button>
      <pre aria-live="polite" data-completed={completed}>
        {results
          .map(
            (result) =>
              `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? `: ${result.detail}` : ''}`,
          )
          .join('\n')}
      </pre>
    </>
  )
}

;(window as Window & { __ari?: { state: () => unknown } }).__ari = {
  state: () => ({
    running,
    results,
    errors,
    commits,
    listeners: listenerCount(),
    lists: Object.fromEntries([...reads].map(([id, read]) => [id, read()])),
  }),
}
createRoot(document.getElementById('root')!).render(<App />)
