/**
 * Injected into the guest page by browser_clock. Built from line arrays so the
 * main bundle never carries a multi-line template literal (esbuild CJS shims split those).
 *
 * The first freeze installs window.__ariClock, which wraps requestAnimationFrame,
 * cancelAnimationFrame, performance.now and Date.now for the rest of the page's life.
 * Resume continues from virtual time with an offset, so neither clock ever runs
 * backwards. A navigation drops the shim with the old document, and step or resume
 * on a page without a frozen clock reports that instead of acting.
 */
export type ClockAction = 'freeze' | 'step' | 'resume'

export const DEFAULT_CLOCK_FPS = 60
export const MAX_CLOCK_STEP_MS = 60_000
export const MAX_CLOCK_FPS = 240
/** How long freeze watches the page for changes the shim did not stop. */
export const CLOCK_WATCH_MS = 250

const SHIM = [
  'const w = window',
  'let c = w.__ariClock',
  "if (action !== 'freeze' && !(c && c.frozen)) return { notFrozen: true }",
  'const installing = !c',
  'if (installing) {',
  '  const real = {',
  '    raf: w.requestAnimationFrame.bind(w),',
  '    caf: w.cancelAnimationFrame.bind(w),',
  '    perf: w.performance.now.bind(w.performance),',
  '    date: w.Date.now.bind(w.Date),',
  '  }',
  '  let nextId = 1e9',
  '  c = w.__ariClock = { frozen: false, real, queue: new Map(), t: 0, t0: 0, date0: 0, offset: 0, dateOffset: 0 }',
  '  w.performance.now = function() { return c.frozen ? c.t : real.perf() + c.offset }',
  '  w.Date.now = function() { return Math.floor(c.frozen ? c.date0 + c.t - c.t0 : real.date() + c.dateOffset) }',
  '  w.requestAnimationFrame = function(cb) {',
  '    if (c.frozen) { nextId++; c.queue.set(nextId, cb); return nextId }',
  '    return real.raf(function(ts) {',
  '      if (c.frozen) { nextId++; c.queue.set(nextId, cb) } else cb(ts + c.offset)',
  '    })',
  '  }',
  '  w.cancelAnimationFrame = function(id) { if (!c.queue.delete(id)) real.caf(id) }',
  '}',
  "if (action === 'freeze') {",
  '  if (c.frozen) return { already: true, now: c.t }',
  '  c.t = c.t0 = w.performance.now()',
  '  c.date0 = w.Date.now()',
  '  c.frozen = true',
  // A frame the page scheduled before the shim existed can still fire once; let it land now.
  '  if (installing) await new Promise(function(done) { c.real.raf(done); w.setTimeout(done, 100) })',
  // A page that saved the real rAF/clock before the shim, or animates with timers or CSS, keeps changing.
  '  function canvasHashes() {',
  "    return Array.from(w.document.querySelectorAll('canvas')).slice(0, 8).map(function(cv) {",
  '      try {',
  "        const probe = w.document.createElement('canvas')",
  '        probe.width = probe.height = 64',
  "        const ctx = probe.getContext('2d')",
  '        ctx.drawImage(cv, 0, 0, 64, 64)',
  '        const px = ctx.getImageData(0, 0, 64, 64).data',
  '        let h = 0',
  '        for (let i = 0; i < px.length; i++) h = (h * 31 + px[i]) | 0',
  '        return h',
  '      } catch (e) { return null }',
  '    })',
  '  }',
  '  const before = canvasHashes()',
  '  let mutations = 0',
  '  const observer = new w.MutationObserver(function(records) { mutations += records.length })',
  '  observer.observe(w.document, { subtree: true, childList: true, attributes: true, characterData: true })',
  '  await new Promise(function(done) { w.setTimeout(done, WATCH_MS) })',
  '  observer.disconnect()',
  '  const canvases = canvasHashes().filter(function(h, i) { return h !== before[i] }).length',
  '  return { already: false, now: c.t, mutations, canvases }',
  '}',
  "if (action === 'step') {",
  '  const start = c.t',
  '  const frames = Math.floor((ms * fps) / 1000)',
  '  let framesRun = 0, callbacks = 0, errors = 0, firstError = null',
  '  for (let i = 1; i <= frames; i++) {',
  '    c.t = start + (i * 1000) / fps',
  '    const batch = Array.from(c.queue.values())',
  '    c.queue.clear()',
  '    if (batch.length) framesRun++',
  '    for (const cb of batch) {',
  '      callbacks++',
  '      try { cb(c.t) } catch (e) { errors++; if (firstError === null) firstError = String(e && e.message ? e.message : e) }',
  '    }',
  '  }',
  '  c.t = start + ms',
  '  return { frames, framesRun, callbacks, errors, firstError, now: c.t }',
  '}',
  'const queued = Array.from(c.queue.values())',
  'c.queue.clear()',
  'c.offset = c.t - c.real.perf()',
  'c.dateOffset = c.date0 + c.t - c.t0 - c.real.date()',
  'c.frozen = false',
  'for (const cb of queued) w.requestAnimationFrame(cb)',
  'return { resumed: queued.length, now: c.t }',
]

export function clockSource(action: ClockAction, ms = 0, fps = DEFAULT_CLOCK_FPS): string {
  return [
    '(async () => {',
    `const action = ${JSON.stringify(action)}, ms = ${String(ms)}, fps = ${String(fps)}, WATCH_MS = ${String(CLOCK_WATCH_MS)}`,
    ...SHIM,
    '})()',
  ].join('\n')
}

const NOT_FROZEN =
  'clock is not frozen on this page (it may have navigated); call browser_clock with action freeze first'

function num(value: unknown): number {
  return typeof value === 'number' ? value : NaN
}

function fmt(value: unknown): string {
  return `${num(value).toFixed(1)} ms`
}

/** The tool's text for a script result, and whether it is an error. */
export function clockText(
  action: ClockAction,
  stepMs: number,
  fps: number,
  raw: unknown,
): { text: string; isError: boolean } {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (r['notFrozen'] === true) return { text: NOT_FROZEN, isError: true }
  if (action === 'freeze') {
    if (r['already'] === true) {
      return { text: `clock already frozen at performance.now() ${fmt(r['now'])}`, isError: false }
    }
    const mutations = num(r['mutations'])
    const canvases = num(r['canvases'])
    const frozen = `clock frozen at performance.now() ${fmt(r['now'])}`
    if (mutations > 0 || canvases > 0) {
      return {
        text: `${frozen}, but the page kept changing in the ${String(CLOCK_WATCH_MS)} ms after freeze (${String(mutations)} DOM mutations, ${String(canvases)} canvases redrawn); it likely saved its own requestAnimationFrame, performance.now or Date.now before the freeze, or animates with timers or CSS, so stepping may not control it.`,
        isError: false,
      }
    }
    return {
      text: `${frozen}. requestAnimationFrame, performance.now and Date.now stay virtual until resume; navigating drops the freeze.`,
      isError: false,
    }
  }
  if (action === 'resume') {
    return {
      text: `clock resumed from virtual time ${fmt(r['now'])}; ${String(num(r['resumed']))} queued requestAnimationFrame callbacks handed back to the page`,
      isError: false,
    }
  }
  const framesRun = num(r['framesRun'])
  const errors = num(r['errors'])
  const thrown =
    errors > 0 ? `; ${String(errors)} callbacks threw, first: ${String(r['firstError'])}` : ''
  if (framesRun === 0) {
    const why =
      num(r['frames']) === 0
        ? `${String(stepMs)} ms is shorter than one frame at ${String(fps)} fps`
        : 'the page has no requestAnimationFrame callbacks queued'
    return {
      text: `no frames stepped: ${why}; virtual time advanced to ${fmt(r['now'])}`,
      isError: false,
    }
  }
  return {
    text: `stepped ${String(num(r['frames']))} frames (${String(stepMs)} ms at ${String(fps)} fps); ${String(framesRun)} ran requestAnimationFrame callbacks (${String(num(r['callbacks']))} calls); performance.now() is ${fmt(r['now'])}${thrown}`,
    isError: false,
  }
}
