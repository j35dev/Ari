import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserService, type BrowserGuest, type BrowserGuestFactory } from './browser-service'
import {
  BROWSER_STATE_TIMEOUT_MS,
  dispatchBrowserMcpTool,
  startBrowserMcpServer,
} from './browser-mcp'

interface DomWindow {
  document: Document
  eval(source: string): unknown
  close(): void
}

interface Dom {
  window: DomWindow
}

type DomConstructor = new (html: string, options: { runScripts: 'dangerously'; url: string }) => Dom

// The jsdom environment exposes its JSDOM instance; its constructor gives each
// fake tab a real DOM window that runs the page's own <script>. It is not
// Chromium: no layout, no requestAnimationFrame, no Electron.
const JSDOM = (globalThis as unknown as { jsdom: { constructor: DomConstructor } }).jsdom
  .constructor

interface ToolResult {
  content: { type: string; text?: string }[]
  isError?: boolean
}

function text(result: ToolResult | undefined): string {
  if (result === undefined) throw new Error('tool result has not settled')
  const first = result.content[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}

function browserGuest(pages: Readonly<Record<string, string>>): BrowserGuestFactory {
  return () => {
    let dom: Dom | null = null
    let url = 'about:blank'
    return {
      loadURL: async (next: string) => {
        const html = pages[new URL(next).pathname]
        if (html === undefined) throw new Error(`no fixture for ${next}`)
        url = next
        dom?.window.close()
        dom = new JSDOM(html, { runScripts: 'dangerously', url: next })
      },
      goBack: () => {},
      goForward: () => {},
      reload: () => {},
      canGoBack: () => false,
      canGoForward: () => false,
      getURL: () => url,
      getTitle: () => dom?.window.document.title ?? '',
      isLoading: () => false,
      executeJavaScript: async (code: string): Promise<unknown> => {
        if (dom === null) return undefined
        return dom.window.eval(code)
      },
      capturePage: async () => null,
      consoleEntries: () => [],
      sendKey: () => {},
      setBounds: () => {},
      setVisible: () => {},
      destroy: () => dom?.window.close(),
    } satisfies BrowserGuest
  }
}

function serviceFor(pages: Readonly<Record<string, string>>): BrowserService {
  return new BrowserService(browserGuest(pages), vi.fn())
}

function page(script: string): string {
  return `<!doctype html><html><head><title>Hook Page</title></head><body><script>${script}</script></body></html>`
}

function delayedState(delayMs: number): string {
  return page(
    `window.__ari = { state: function () { return new Promise(function (resolve) { setTimeout(function () { resolve({ ok: true }) }, ${String(delayMs)}) }) } }`,
  )
}

async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const body = (await response.json()) as { result: ToolResult }
  return body.result
}

afterEach(() => {
  vi.useRealTimers()
})

const GAME_URL = 'http://127.0.0.1:9/game.html'

function gameState(gen: number, score: number): string {
  return JSON.stringify({
    gen,
    level: 1,
    player: { x: 2, y: 3, alive: true },
    score,
    title: 'Game Fixture',
    canvas: { width: 320, height: 180 },
  })
}

async function withGameServer(
  run: (
    call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>,
  ) => Promise<void>,
): Promise<void> {
  const gameHtml = await readFile(
    join(import.meta.dirname, 'testing/browser-state-game.html'),
    'utf8',
  )
  const handle = await startBrowserMcpServer(serviceFor({ '/game.html': gameHtml }))
  const token = handle.tokenFor('sess-a')
  try {
    await run((name, args) => callTool(handle.url, token, name, args))
  } finally {
    handle.close()
  }
}

describe('browser_state against the game fixture page over HTTP', () => {
  it('reads the game state the page exposes, end to end', async () => {
    await withGameServer(async (call) => {
      const nav = await call('browser_navigate', { url: GAME_URL })
      expect(nav.isError).toBeUndefined()
      await call('browser_click', { selector: '#start' })
      await call('browser_click', { selector: '#score' })
      await call('browser_click', { selector: '#score' })

      const state = await call('browser_state')

      expect(text(state)).toBe(gameState(1, 20))
      expect(state.isError).toBeUndefined()
    })
  })

  it('sees a hook set up after navigation, then the object that replaces it', async () => {
    await withGameServer(async (call) => {
      await call('browser_navigate', { url: GAME_URL })

      const before = await call('browser_state')
      expect(text(before)).toContain('This page has no window.__ari.state() hook')
      expect(before.isError).toBeUndefined()

      await call('browser_click', { selector: '#start' })
      const started = await call('browser_state')
      expect(text(started)).toBe(gameState(1, 0))
      expect(started.isError).toBeUndefined()

      await call('browser_click', { selector: '#score' })
      await call('browser_click', { selector: '#new-game' })
      const replaced = await call('browser_state')
      expect(text(replaced)).toBe(gameState(2, 0))
      expect(replaced.isError).toBeUndefined()
    })
  })
})

describe('browser_state near the time limit', () => {
  async function stateAfter(
    delayMs: number,
    advanceMs: number,
  ): Promise<{
    before: ToolResult | undefined
    after: ToolResult | undefined
  }> {
    vi.useFakeTimers()
    const service = serviceFor({ '/slow.html': delayedState(delayMs) })
    await dispatchBrowserMcpTool(service, 'browser_navigate', {
      url: 'http://127.0.0.1:9/slow.html',
    })
    let settled: ToolResult | undefined
    const pending = dispatchBrowserMcpTool(service, 'browser_state', {}).then((result) => {
      settled = result
    })
    await vi.advanceTimersByTimeAsync(advanceMs - 1)
    const before = settled
    await vi.advanceTimersByTimeAsync(1)
    const after = settled
    // Let the slower of the two page timers fire so nothing is left pending.
    await vi.advanceTimersByTimeAsync(Math.abs(delayMs - BROWSER_STATE_TIMEOUT_MS))
    await pending
    return { before, after }
  }

  it('returns a hook that resolves 1 ms before the limit', async () => {
    const { before, after } = await stateAfter(
      BROWSER_STATE_TIMEOUT_MS - 1,
      BROWSER_STATE_TIMEOUT_MS - 1,
    )
    expect(before, 'settled 1 ms before the boundary').toBeUndefined()
    expect(text(after)).toBe('{"ok":true}')
    expect(after?.isError).toBeUndefined()
  })

  it('fails a hook that resolves 1 ms after the limit, at the limit', async () => {
    const { before, after } = await stateAfter(
      BROWSER_STATE_TIMEOUT_MS + 1,
      BROWSER_STATE_TIMEOUT_MS,
    )
    expect(before, 'settled 1 ms before the boundary').toBeUndefined()
    expect(text(after)).toContain('did not settle within 5 s')
    expect(after?.isError).toBe(true)
  })
})

describe('browser_state non-JSON values', () => {
  it('reports a BigInt hook as an error', async () => {
    const service = serviceFor({
      '/big.html': page('window.__ari = { state: function () { return { big: 1n } } }'),
    })
    await dispatchBrowserMcpTool(service, 'browser_navigate', {
      url: 'http://127.0.0.1:9/big.html',
    })
    const result = await dispatchBrowserMcpTool(service, 'browser_state', {})
    expect(text(result)).toContain('BigInt')
    expect(result.isError).toBe(true)
  })

  it('serializes non-JSON object fields the way JSON.stringify does', async () => {
    const service = serviceFor({
      '/values.html': page(
        'window.__ari = { state: function () { return { fn: function () {}, nan: NaN, inf: -Infinity, when: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), undef: undefined, arr: [function () {}, undefined, NaN] } } }',
      ),
    })
    await dispatchBrowserMcpTool(service, 'browser_navigate', {
      url: 'http://127.0.0.1:9/values.html',
    })
    const result = await dispatchBrowserMcpTool(service, 'browser_state', {})
    expect(text(result)).toBe(
      '{"nan":null,"inf":null,"when":"2026-01-02T03:04:05.000Z","arr":[null,null,null]}',
    )
    expect(result.isError).toBeUndefined()
  })

  it('turns a top-level function, undefined, or NaN into null', async () => {
    for (const value of ['function () {}', 'undefined', 'NaN']) {
      const service = serviceFor({
        '/value.html': page(`window.__ari = { state: function () { return ${value} } }`),
      })
      await dispatchBrowserMcpTool(service, 'browser_navigate', {
        url: 'http://127.0.0.1:9/value.html',
      })
      const result = await dispatchBrowserMcpTool(service, 'browser_state', {})
      expect(text(result)).toBe('null')
      expect(result.isError).toBeUndefined()
    }
  })
})
