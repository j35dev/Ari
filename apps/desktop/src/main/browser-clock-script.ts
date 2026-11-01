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
  'if (!c) {',
  '  const real = {',
  '    raf: w.requestAnimationFrame.bind(w),',
  '    caf: w.cancelAnimationFrame.bind(w),',
  '    perf: w.performance.now.bind(w.performance),',
  '    date: w.Date.now.bind(w.Date),',
  '  }',
  '  let nextId = 1e9',
  // Every id the page receives stays valid until its callback runs or is cancelled. While frozen an
  // entry only waits in `pending`; otherwise it also holds the native frame that will run it.
  '  c = w.__ariClock = { frozen: false, real, pending: new Map(), t: 0, t0: 0, date0: 0, offset: 0, dateOffset: 0 }',
  '  c.arm = function(id, entry) {',
  '    entry.native = real.raf(function(ts) {',
  '      if (c.pending.get(id) !== entry) return',
  '      c.pending.delete(id)',
  '      entry.cb(ts + c.offset)',
  '    })',
  '  }',
  '  w.performance.now = function() { return c.frozen ? c.t : real.perf() + c.offset }',
  '  w.Date.now = function() { return Math.floor(c.frozen ? c.date0 + c.t - c.t0 : real.date() + c.dateOffset) }',
  '  w.requestAnimationFrame = function(cb) {',
  '    const id = ++nextId, entry = { cb, native: null }',
  '    c.pending.set(id, entry)',
  '    if (!c.frozen) c.arm(id, entry)',
  '    return id',
  '  }',
  '  w.cancelAnimationFrame = function(id) {',
  '    const entry = c.pending.get(id)',
  '    if (!entry) return real.caf(id)',
  '    c.pending.delete(id)',
  '    if (entry.native !== null) real.caf(entry.native)',
  '  }',
  '}',
  "if (action === 'freeze') {",
  '  if (c.frozen) return { already: true, now: c.t }',
  '  c.t = c.t0 = w.performance.now()',
  '  c.date0 = w.Date.now()',
  '  c.frozen = true',
  // Frames armed before this freeze become steppable instead of waiting for a real frame.
  '  for (const entry of c.pending.values()) {',
  '    if (entry.native !== null) c.real.caf(entry.native)',
  '    entry.native = null',
  '  }',
  // Let a frame the page scheduled before the shim existed land, and the last drawn frame reach the
  // screen before freezeClock captures it.
  '  await new Promise(function(done) { c.real.raf(function() { c.real.raf(done) }); w.setTimeout(done, 100) })',
  // freezeClock reads this back after watching the page; see WATCH_END_SOURCE.
  '  const watch = c.watch = { mutations: 0, observer: null }',
  '  watch.observer = new w.MutationObserver(function(records) { watch.mutations += records.length })',
  '  watch.observer.observe(w.document, { subtree: true, childList: true, attributes: true, characterData: true })',
  '  return { already: false, now: c.t }',
  '}',
  "if (action === 'step') {",
  '  const start = c.t',
  '  const frames = Math.floor((ms * fps) / 1000)',
  '  let framesRun = 0, callbacks = 0, errors = 0, firstError = null',
  '  for (let i = 1; i <= frames; i++) {',
  '    c.t = start + (i * 1000) / fps',
  '    const ids = Array.from(c.pending.keys())',
  '    if (ids.length) framesRun++',
  '    for (const id of ids) {',
  // A callback cancelled earlier in this frame does not run, as in a browser.
  '      const entry = c.pending.get(id)',
  '      if (!entry) continue',
  '      c.pending.delete(id)',
  '      callbacks++',
  '      try { entry.cb(c.t) } catch (e) { errors++; if (firstError === null) firstError = String(e && e.message ? e.message : e) }',
  '    }',
  '  }',
  '  c.t = start + ms',
  '  return { frames, framesRun, callbacks, errors, firstError, now: c.t }',
  '}',
  'c.offset = c.t - c.real.perf()',
  'c.dateOffset = c.date0 + c.t - c.t0 - c.real.date()',
  'c.frozen = false',
  'for (const [id, entry] of c.pending) c.arm(id, entry)',
  'return { resumed: c.pending.size, now: c.t }',
]

export function clockSource(action: ClockAction, ms = 0, fps = DEFAULT_CLOCK_FPS): string {
  return [
    '(async () => {',
    `const action = ${JSON.stringify(action)}, ms = ${String(ms)}, fps = ${String(fps)}`,
    ...SHIM,
    '})()',
  ].join('\n')
}

const WATCH_END_SOURCE = [
  '(() => {',
  'const c = window.__ariClock, watch = c && c.watch',
  'if (!watch) return 0',
  'watch.observer.disconnect()',
  'c.watch = null',
  'return watch.mutations',
  '})()',
].join('\n')

/**
 * Freezes, then watches the page for CLOCK_WATCH_MS. A page the shim does not control (it saved
 * its own rAF or clock, or animates with timers or CSS) keeps mutating its DOM or repainting,
 * which two captures of the page catch even for WebGL.
 */
export async function freezeClock(
  run: (code: string) => Promise<unknown>,
  capture: () => Promise<string | null>,
): Promise<unknown> {
  const frozen = await run(clockSource('freeze'))
  if (frozen === null || typeof frozen !== 'object' || !('already' in frozen) || frozen.already !== false) {
    return frozen
  }
  const before = await capture()
  await new Promise((resolve) => setTimeout(resolve, CLOCK_WATCH_MS))
  const after = await capture()
  const mutations = await run(WATCH_END_SOURCE)
  return { ...frozen, mutations, repainted: before !== null && after !== null && before !== after }
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
    const repainted = r['repainted'] === true
    const frozen = `clock frozen at performance.now() ${fmt(r['now'])}`
    if (mutations > 0 || repainted) {
      return {
        text: `${frozen}, but the page kept changing in the ${String(CLOCK_WATCH_MS)} ms after freeze (${String(mutations)} DOM mutations, page image ${repainted ? 'changed' : 'unchanged'}); it likely saved its own requestAnimationFrame, performance.now or Date.now before the freeze, or animates with timers or CSS, so stepping may not control it.`,
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
