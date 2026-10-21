/* global window, document, performance, PerformanceObserver, MessageChannel, requestAnimationFrame, setTimeout, addEventListener, removeEventListener, innerHeight */
// Injected into the renderer before any app script runs (or on attach when
// that was too late). Everything reads `performance.now()`; the harness turns
// marks into wall-clock times through `performance.timeOrigin`.
;(() => {
  if (window.__perf) return
  const P = (window.__perf = {
    lt: [],
    marks: {},
    rec: null,
    lastKey: null,
    injectedAt: performance.now(),
  })
  const afterPaint = (cb) =>
    requestAnimationFrame(() => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => cb(performance.now())
      ch.port2.postMessage(0)
    })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.lt.push([e.startTime, e.duration])
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    P.noLongTask = true
  }

  // Boot marks: the shell's "New session" button mounted, then hit-testable
  // (nothing — the launch splash included — covering it).
  const boot = () => {
    const button = document.querySelector('button[aria-label="New session"]')
    if (button && P.marks.shell === undefined) P.marks.shell = performance.now()
    if (button) {
      const r = button.getBoundingClientRect()
      const hit = r.width > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (hit && button.contains(hit)) return void (P.marks.interactive = performance.now())
    }
    setTimeout(boot, 25)
  }
  boot()

  P.boot = () => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    return {
      origin: performance.timeOrigin,
      fcp: fcp?.startTime ?? null,
      injectedAt: P.injectedAt,
      ...P.marks,
    }
  }

  // Session switch: pointerdown on the row → first painted frame in which the
  // target transcript's end marker is laid out; then idle until long tasks stop.
  P.armSwitch = (href, settleMs = 1500, maxMs = 30000) => {
    const ltFrom = P.lt.length
    let start = null
    const onDown = (e) => {
      start = e.timeStamp
      removeEventListener('pointerdown', onDown, true)
    }
    addEventListener('pointerdown', onDown, true)
    P.pending = new Promise((resolve) => {
      const t0 = performance.now()
      const finish = (painted) =>
        setTimeout(() => {
          const lts = P.lt.slice(ltFrom).filter(([s]) => s >= start - 1)
          const end = Math.max(painted, ...lts.map(([s, d]) => s + d))
          resolve({
            paintMs: painted - start,
            settleMs: end - start,
            longTasks: lts.length,
            longTaskMs: lts.reduce((a, [, d]) => a + d, 0),
          })
        }, settleMs)
      const tick = () => {
        const el = start !== null && document.querySelector(`a[href="${href}"]`)
        if (el && el.getBoundingClientRect().height > 0) return afterPaint(finish)
        if (performance.now() - t0 > maxMs)
          return resolve({ error: `marker ${href} not painted in ${maxMs} ms` })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return true
  }

  addEventListener('keydown', (e) => (P.lastKey = e.timeStamp), true)
  addEventListener(
    'input',
    () => {
      const S = P.rec
      const from = P.lastKey
      if (!S?.on || from === null) return
      P.lastKey = null
      afterPaint((t) => S.keys.push(t - from))
    },
    true,
  )

  // Streaming window: frame deltas, typing latency, and ping round trips.
  P.begin = () => {
    const S = (P.rec = {
      t0: performance.now(),
      ltFrom: P.lt.length,
      frames: [],
      keys: [],
      pings: [],
      on: true,
    })
    let last = null
    const frame = (t) => {
      if (!S.on) return
      if (last !== null) S.frames.push(t - last)
      last = t
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    void (async () => {
      while (S.on) {
        const a = performance.now()
        await window.ari.invoke('ping')
        S.pings.push(performance.now() - a)
        await new Promise((r) => setTimeout(r, 250))
      }
    })()
    return true
  }
  P.end = () => {
    const S = P.rec
    S.on = false
    const lts = P.lt.slice(S.ltFrom).filter(([s]) => s >= S.t0)
    return {
      durationMs: performance.now() - S.t0,
      frames: S.frames,
      keys: S.keys,
      pings: S.pings,
      longTasks: lts.map(([, d]) => d),
    }
  }

  P.composer = () => {
    const visible = (el) => el.getBoundingClientRect().height > 0
    const el = [
      ...document.querySelectorAll(
        'textarea[aria-label="Message"], [role="textbox"][aria-label="Message"], textarea',
      ),
    ].find(visible)
    if (!el) return false
    el.focus()
    return document.activeElement === el
  }

  // Sidebar row by exact title text, scrolled into view; returns its centre.
  P.row = (title) => {
    const scope = document.querySelector('nav[aria-label="Sessions"]') ?? document.body
    const label = [...scope.querySelectorAll('span, div, p')].find(
      (e) => e.childElementCount === 0 && e.textContent.trim() === title,
    )
    const row = label?.closest('button, [role="button"], [role="treeitem"], a')
    if (!row) return null
    row.scrollIntoView({ block: 'center' })
    const r = row.getBoundingClientRect()
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight
      ? { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }
      : null
  }
})()
