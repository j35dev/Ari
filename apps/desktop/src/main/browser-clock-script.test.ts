import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { dispatchBrowserMcpTool } from './browser-mcp'
import { BrowserService, type BrowserGuest } from './browser-service'

/**
 * A page with a fake compositor: `paint()` is one real browser frame and
 * `elapse()` moves real time. Injected scripts run against `window` for real.
 */
function fakePage(loop: 'none' | 'shimmed' | 'cached') {
  let realNow = 5000
  let nextId = 0
  const frames = new Map<number, (ts: number) => void>()
  const window = {
    requestAnimationFrame: (cb: (ts: number) => void) => {
      nextId++
      frames.set(nextId, cb)
      return nextId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    performance: { now: () => realNow },
    Date: { now: () => 1_700_000_000_000 + Math.floor(realNow) },
    setTimeout,
    document: document.implementation.createHTMLDocument('game'),
    MutationObserver,
  }
  const game = { frames: 0, lastTs: 0 }
  // A 'cached' page saves the native rAF at load, so the shim never sees its loop.
  const raf = loop === 'cached' ? window.requestAnimationFrame : null
  const tick = (ts: number): void => {
    game.frames++
    game.lastTs = ts
    window.document.body.textContent = String(game.frames)
    ;(raf ?? window.requestAnimationFrame)(tick)
  }
  if (loop !== 'none') window.requestAnimationFrame(tick)
  return {
    window,
    game,
    paint: () => {
      const batch = [...frames.values()]
      frames.clear()
      for (const cb of batch) cb(realNow)
    },
    elapse: (ms: number) => {
      realNow += ms
    },
  }
}

type Page = ReturnType<typeof fakePage>

/** A tab whose every navigation loads a fresh page, like a real document swap. */
function setup(loop: 'none' | 'shimmed' | 'cached' = 'shimmed') {
  let page = fakePage(loop)
  let url = 'about:blank'
  const guest: BrowserGuest = {
    loadURL: vi.fn(async (next: string) => {
      url = next
      page = fakePage(loop)
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    getURL: () => url,
    getTitle: () => 'Game',
    isLoading: () => false,
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> =>
      runInNewContext(code, { window: page.window }),
    ),
    capturePage: vi.fn(async () => null),
    consoleEntries: () => [],
    sendKey: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
  }
  const service = new BrowserService(() => guest, vi.fn())
  const clock = async (args: Record<string, unknown>) => {
    const result = await dispatchBrowserMcpTool(service, 'browser_clock', args)
    const first = result.content[0]
    return { text: first?.type === 'text' ? first.text : '', isError: result.isError === true }
  }
  return { service, clock, page: (): Page => page }
}

/** Freezes while the browser keeps painting real frames, as it does during the watch. */
async function freeze(env: ReturnType<typeof setup>) {
  const compositor = setInterval(() => {
    env.page().elapse(16)
    env.page().paint()
  }, 16)
  try {
    return await env.clock({ action: 'freeze' })
  } finally {
    clearInterval(compositor)
  }
}

describe('browser_clock', () => {
  it('steps 1000 ms at 60 fps as 60 frames of virtual time', async () => {
    const env = setup()
    await freeze(env)
    const { game, window } = env.page()
    const before = game.frames
    const frozenAt = window.performance.now()

    const step = await env.clock({ action: 'step', ms: 1000 })

    expect(step.isError).toBe(false)
    expect(step.text).toContain('stepped 60 frames')
    expect(game.frames - before).toBe(60)
    expect(window.performance.now()).toBe(frozenAt + 1000)
    expect(game.lastTs).toBe(frozenAt + 1000)
  })

  it('honours fps', async () => {
    const env = setup()
    await freeze(env)
    const before = env.page().game.frames

    await env.clock({ action: 'step', ms: 500, fps: 30 })

    expect(env.page().game.frames - before).toBe(15)
  })

  it('holds the frame counter and both clocks still while frozen', async () => {
    const env = setup()
    const frozen = await freeze(env)
    const { game, window, paint, elapse } = env.page()
    const frames = game.frames
    const perf = window.performance.now()
    const date = window.Date.now()

    for (let i = 0; i < 60; i++) {
      elapse(1000 / 60)
      paint()
    }

    expect(frozen.text).toContain('clock frozen')
    expect(game.frames).toBe(frames)
    expect(window.performance.now()).toBe(perf)
    expect(window.Date.now()).toBe(date)
  })

  it('resumes from virtual time without going backwards and runs the queued frame', async () => {
    const env = setup()
    await freeze(env)
    const { game, window, paint, elapse } = env.page()
    await env.clock({ action: 'step', ms: 3000 })
    elapse(200)
    const perf = window.performance.now()
    const date = window.Date.now()
    const frames = game.frames

    const resumed = await env.clock({ action: 'resume' })
    elapse(16)
    paint()

    expect(resumed.text).toContain('1 queued requestAnimationFrame callbacks')
    expect(game.frames).toBe(frames + 1)
    expect(game.lastTs).toBe(perf + 16)
    expect(window.performance.now()).toBe(perf + 16)
    expect(window.Date.now()).toBeGreaterThanOrEqual(date + 16)
    expect(window.Date.now()).toBeLessThanOrEqual(date + 17)
  })

  it('refuses to step or resume a page that navigated away from the freeze', async () => {
    const env = setup()
    await freeze(env)
    await dispatchBrowserMcpTool(env.service, 'browser_navigate', { url: 'example.com' })
    const frames = env.page().game.frames

    const step = await env.clock({ action: 'step', ms: 1000 })
    const resume = await env.clock({ action: 'resume' })

    expect(step).toEqual({
      text: 'clock is not frozen on this page (it may have navigated); call browser_clock with action freeze first',
      isError: true,
    })
    expect(resume.isError).toBe(true)
    expect(env.page().game.frames).toBe(frames)
  })

  it('says no frames stepped when the page has no animation frames queued', async () => {
    const env = setup('none')
    await freeze(env)

    const step = await env.clock({ action: 'step', ms: 1000 })

    expect(step).toEqual({
      text: 'no frames stepped: the page has no requestAnimationFrame callbacks queued; virtual time advanced to 6000.0 ms',
      isError: false,
    })
  })

  it('warns when the page keeps changing after freeze because it cached rAF', async () => {
    const env = setup('cached')

    const frozen = await freeze(env)

    expect(frozen.isError).toBe(false)
    expect(frozen.text).toMatch(
      /^clock frozen at performance\.now\(\) [\d.]+ ms, but the page kept changing in the 250 ms after freeze \(\d+ DOM mutations, 0 canvases redrawn\); it likely saved its own requestAnimationFrame/,
    )
    expect(frozen.text).not.toContain('(0 DOM mutations')
  })

  it('does not warn when the shim holds the page still', async () => {
    const env = setup('shimmed')

    const frozen = await freeze(env)

    expect(frozen.text).toMatch(/^clock frozen at performance\.now\(\) [\d.]+ ms\. requestAnimationFrame/)
  })

  it('rejects a step without a usable ms', async () => {
    const env = setup()
    await freeze(env)

    expect(await env.clock({ action: 'step' })).toEqual({
      text: 'ms must be a number from 1 to 60000',
      isError: true,
    })
  })
})
