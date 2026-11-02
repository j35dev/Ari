import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeCapture, type CapturedImage } from './browser-capture'
import { BrowserService, type BrowserGuest } from './browser-service'
import {
  BROWSER_MCP_TOOLS,
  BROWSER_STATE_TIMEOUT_MS,
  dispatchBrowserMcpTool,
  MAX_BROWSER_STATE_CHARS,
  startBrowserMcpServer,
  writeBrowserMcpProxy,
} from './browser-mcp'
import { useTempDirs } from './testing/temp-dirs'

const tempDir = useTempDirs()

function guest(): BrowserGuest {
  let url = 'about:blank'
  return {
    loadURL: vi.fn(async (next: string) => {
      url = next
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    getURL: () => url,
    getTitle: () => 'Example',
    isLoading: () => false,
    executeJavaScript: vi.fn(async (code: string) => {
      if (code.includes('el.click()') || code.includes('el.focus()')) return true
      if (code.includes('innerWidth')) return [800, 600]
      return { url, title: 'Example', text: 'hi', elements: [] }
    }),
    capturePage: vi.fn(async () => null),
    consoleEntries: () => [],
    sendKey: vi.fn(),
    sendMouse: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
  }
}

/** A guest whose page scripts really run, with `page` as the page's `window`. */
function pageGuest(page: Record<string, unknown>): BrowserGuest {
  const g = guest()
  g.executeJavaScript = vi.fn(async (code: string): Promise<unknown> =>
    runInNewContext(code, { window: page, setTimeout, clearTimeout }),
  )
  return g
}

function text(result: Awaited<ReturnType<typeof dispatchBrowserMcpTool>>): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : ''
}

describe('dispatchBrowserMcpTool', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('navigates and snapshots the shared guest', async () => {
    const service = new BrowserService(() => guest(), vi.fn())
    const nav = await dispatchBrowserMcpTool(service, 'browser_navigate', { url: 'example.com' })
    expect(nav.isError).toBeUndefined()
    expect(text(nav)).toContain('https://example.com')
    const snap = await dispatchBrowserMcpTool(service, 'browser_snapshot', {})
    expect(text(snap)).toContain('Example')
    const bad = await dispatchBrowserMcpTool(service, 'browser_navigate', { url: 'file:///x' })
    expect(bad.isError).toBe(true)
  })

  it('adds console warnings and errors to a snapshot, not ordinary logs', async () => {
    const g = guest()
    g.consoleEntries = () => [
      { level: 'info', text: 'hello', timestamp: 1 },
      { level: 'warning', text: 'slow frame', timestamp: 2 },
      { level: 'error', text: 'boom', timestamp: 3 },
    ]
    const service = new BrowserService(() => g, vi.fn())

    const snap = await dispatchBrowserMcpTool(service, 'browser_snapshot', {})
    const payload = JSON.parse(text(snap)) as {
      text: string
      consoleEntries: { level: string; text: string }[]
    }
    expect(payload.text).toBe('hi')
    expect(payload.consoleEntries.map((entry) => entry.text)).toEqual(['slow frame', 'boom'])
  })

  it('returns a screenshot as a bare base64 image block', async () => {
    const g = guest()
    const capturePage = vi.fn(async () => Buffer.from('jpeg'))
    g.capturePage = capturePage
    const service = new BrowserService(() => g, vi.fn())
    const shot = await dispatchBrowserMcpTool(service, 'browser_screenshot', {})
    expect(shot.isError).toBeUndefined()
    expect(shot.content).toEqual([
      { type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' },
    ])
    expect(capturePage).toHaveBeenCalledWith(undefined, 'jpeg', { width: 800, height: 600 })
  })

  it('scales a 2x screenshot to the CSS viewport, so its pixels are pointer coordinates', async () => {
    const g = guest()
    // A scale-2 screen: the page is 640x512 CSS px, the capture 1280x1024 device px.
    g.executeJavaScript = vi.fn(async () => [640, 512])
    const image = (width: number, height: number): CapturedImage => ({
      getSize: () => ({ width, height }),
      resize: (size) => image(size.width, size.height),
      toJPEG: () => Buffer.from(`${String(width)}x${String(height)}`),
      toPNG: () => Buffer.from(''),
    })
    g.capturePage = vi.fn(async (_rect, format = 'png', size) =>
      encodeCapture(image(1280, 1024), format, size),
    )
    const service = new BrowserService(() => g, vi.fn())

    const shot = await dispatchBrowserMcpTool(service, 'browser_screenshot', {})
    const first = shot.content[0]
    const data = first?.type === 'image' ? first.data : ''
    expect(Buffer.from(data, 'base64').toString()).toBe('640x512')
  })

  it('reports an error when the screenshot captures nothing', async () => {
    const service = new BrowserService(() => guest(), vi.fn())
    const shot = await dispatchBrowserMcpTool(service, 'browser_screenshot', {})
    expect(shot.isError).toBe(true)
    expect(shot.content[0]?.type).toBe('text')
  })

  it('holds a key for holdMs, clamped to 0-5000', async () => {
    vi.useFakeTimers()
    const g = guest()
    const sendKey = vi.fn()
    g.sendKey = sendKey
    const service = new BrowserService(() => g, vi.fn())

    const held = dispatchBrowserMcpTool(service, 'browser_key', { key: 'ArrowRight', holdMs: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sendKey).toHaveBeenCalledTimes(1)
    expect(sendKey).toHaveBeenLastCalledWith('ArrowRight', 'down', [])
    await vi.advanceTimersByTimeAsync(499)
    expect(sendKey).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sendKey).toHaveBeenLastCalledWith('ArrowRight', 'up', [])
    expect(text(await held)).toBe('pressed ArrowRight for 500ms')

    const long = dispatchBrowserMcpTool(service, 'browser_key', { key: 'a', holdMs: 60_000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(text(await long)).toBe('pressed a for 5000ms')

    const negative = dispatchBrowserMcpTool(service, 'browser_key', { key: 'a', holdMs: -10 })
    await vi.advanceTimersByTimeAsync(0)
    expect(text(await negative)).toBe('pressed a for 0ms')
  })

  it('still sends key up when key down fails, and reports the error', async () => {
    const g = guest()
    const sendKey = vi.fn((_key: string, phase: 'down' | 'up') => {
      if (phase === 'down') throw new Error('guest gone')
    })
    g.sendKey = sendKey
    const service = new BrowserService(() => g, vi.fn())
    const missing = await dispatchBrowserMcpTool(service, 'browser_key', {})
    expect(missing.isError).toBe(true)
    expect(sendKey).not.toHaveBeenCalled()
    const failed = await dispatchBrowserMcpTool(service, 'browser_key', { key: 'a', holdMs: 0 })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe('guest gone')
    expect(sendKey.mock.calls).toEqual([
      ['a', 'down', []],
      ['a', 'up', []],
    ])
  })

  it('reports an error when the guest is gone before key up', async () => {
    const g = guest()
    g.sendKey = vi.fn((_key: string, phase: 'down' | 'up') => {
      if (phase === 'up') throw new Error('Object has been destroyed')
    })
    const service = new BrowserService(() => g, vi.fn())
    const failed = await dispatchBrowserMcpTool(service, 'browser_key', { key: 'a', holdMs: 0 })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe('Object has been destroyed')
  })

  it('returns the page state hook as JSON exactly', async () => {
    const fixture = {
      level: 3,
      player: { x: 12.5, y: -4, alive: true },
      enemies: [{ id: 'e1', hp: 0 }],
      label: 'héllo "quoted" \\ end',
    }
    const service = new BrowserService(
      () => pageGuest({ __ari: { state: () => fixture } }),
      vi.fn(),
    )

    const result = await dispatchBrowserMcpTool(service, 'browser_state', {})

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(JSON.stringify(fixture))
    expect(JSON.parse(text(result))).toEqual(fixture)
  })

  it('awaits a state hook that returns a promise', async () => {
    const service = new BrowserService(
      () => pageGuest({ __ari: { state: async () => ({ score: 7 }) } }),
      vi.fn(),
    )
    expect(text(await dispatchBrowserMcpTool(service, 'browser_state', {}))).toBe('{"score":7}')
  })

  it('answers a page without the hook with a hint naming it, not an error', async () => {
    for (const page of [{}, { __ari: {} }, { __ari: { state: 'not a function' } }]) {
      const service = new BrowserService(() => pageGuest(page), vi.fn())
      const result = await dispatchBrowserMcpTool(service, 'browser_state', {})
      expect(result.isError).toBeUndefined()
      expect(text(result)).toContain('window.__ari.state()')
    }
  })

  it('cuts state over the cap and marks how much was dropped', async () => {
    const big = { blob: 'x'.repeat(MAX_BROWSER_STATE_CHARS) }
    const json = JSON.stringify(big)
    const service = new BrowserService(() => pageGuest({ __ari: { state: () => big } }), vi.fn())

    const out = text(await dispatchBrowserMcpTool(service, 'browser_state', {}))

    const dropped = json.length - MAX_BROWSER_STATE_CHARS
    expect(out).toBe(
      `${json.slice(0, MAX_BROWSER_STATE_CHARS)}…[truncated ${String(dropped)} of ${String(json.length)} chars]`,
    )
  })

  it('cuts oversized state in the page so at most the cap crosses IPC', async () => {
    const big = { blob: 'x'.repeat(MAX_BROWSER_STATE_CHARS * 5) }
    const g = pageGuest({ __ari: { state: () => big } })
    const service = new BrowserService(() => g, vi.fn())

    await dispatchBrowserMcpTool(service, 'browser_state', {})

    const sent = (await vi.mocked(g.executeJavaScript).mock.results[0]?.value) as {
      json: string
      length: number
    }
    expect(sent.json).toHaveLength(MAX_BROWSER_STATE_CHARS)
    expect(sent.length).toBe(JSON.stringify(big).length)
  })

  it('still cuts state a tampered page sends over the cap', async () => {
    const json = 'y'.repeat(MAX_BROWSER_STATE_CHARS + 10)
    const g = guest()
    g.executeJavaScript = vi.fn(async () => ({ hook: true, json, length: 3 }))
    const service = new BrowserService(() => g, vi.fn())

    const out = text(await dispatchBrowserMcpTool(service, 'browser_state', {}))

    expect(out).toBe(
      `${json.slice(0, MAX_BROWSER_STATE_CHARS)}…[truncated 10 of ${String(json.length)} chars]`,
    )
  })

  it('times out in the main process when the page script never returns', async () => {
    vi.useFakeTimers()
    try {
      const g = guest()
      // A page that replaced setTimeout or Promise.race leaves the script hanging.
      g.executeJavaScript = vi.fn(() => new Promise<unknown>(() => {}))
      const service = new BrowserService(() => g, vi.fn())
      const pending = dispatchBrowserMcpTool(service, 'browser_state', {})
      await vi.advanceTimersByTimeAsync(BROWSER_STATE_TIMEOUT_MS)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('did not settle within 5 s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps state at exactly the cap whole', async () => {
    const blob = 'x'.repeat(MAX_BROWSER_STATE_CHARS - '{"blob":""}'.length)
    const service = new BrowserService(
      () => pageGuest({ __ari: { state: () => ({ blob }) } }),
      vi.fn(),
    )
    const out = text(await dispatchBrowserMcpTool(service, 'browser_state', {}))
    expect(out).toBe(JSON.stringify({ blob }))
    expect(out).toHaveLength(MAX_BROWSER_STATE_CHARS)
  })

  it('does not split an emoji when the cap lands inside it', async () => {
    const prefix = '{"s":"'
    const s = `${'x'.repeat(MAX_BROWSER_STATE_CHARS - prefix.length - 1)}😀tail`
    const json = JSON.stringify({ s })
    const service = new BrowserService(
      () => pageGuest({ __ari: { state: () => ({ s }) } }),
      vi.fn(),
    )

    const out = text(await dispatchBrowserMcpTool(service, 'browser_state', {}))

    const kept = MAX_BROWSER_STATE_CHARS - 1
    expect(out).toBe(
      `${json.slice(0, kept)}…[truncated ${String(json.length - kept)} of ${String(json.length)} chars]`,
    )
  })

  it('fails a state hook that never settles after the time limit', async () => {
    vi.useFakeTimers()
    try {
      const service = new BrowserService(
        () => pageGuest({ __ari: { state: () => new Promise(() => {}) } }),
        vi.fn(),
      )
      const pending = dispatchBrowserMcpTool(service, 'browser_state', {})
      await vi.advanceTimersByTimeAsync(BROWSER_STATE_TIMEOUT_MS)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('did not settle within 5 s')
      expect(text(result)).toContain('requestAnimationFrame')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a state hook that throws as an error', async () => {
    const service = new BrowserService(
      () =>
        pageGuest({
          __ari: {
            state: () => {
              throw new Error('state exploded')
            },
          },
        }),
      vi.fn(),
    )
    const result = await dispatchBrowserMcpTool(service, 'browser_state', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('state exploded')
  })

  it('takes no code: browser_state has no params and runs the same fixed script', async () => {
    const tool = BROWSER_MCP_TOOLS.find((t) => t.name === 'browser_state')
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    })

    const g = pageGuest({})
    const service = new BrowserService(() => g, vi.fn())
    await dispatchBrowserMcpTool(service, 'browser_state', {})
    await dispatchBrowserMcpTool(service, 'browser_state', { code: 'window.pwned = 1' })
    const scripts = vi.mocked(g.executeJavaScript).mock.calls.map(([code]) => code)
    expect(scripts).toHaveLength(2)
    expect(scripts[1]).toBe(scripts[0])
    expect(scripts[1]).not.toContain('pwned')
  })

  it('clicks with pointer down then up at the given point', async () => {
    const g = guest()
    const sendMouse = vi.fn()
    g.sendMouse = sendMouse
    const service = new BrowserService(() => g, vi.fn())

    const result = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'click',
      x: 123,
      y: 45,
    })

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe('click at 123,45')
    expect(sendMouse.mock.calls).toEqual([
      ['down', 123, 45, 'left', []],
      ['up', 123, 45, 'left', []],
    ])
  })

  it('drags through moves and releases at the destination', async () => {
    const g = guest()
    const sendMouse = vi.fn()
    g.sendMouse = sendMouse
    const service = new BrowserService(() => g, vi.fn())

    const result = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'drag',
      x: 10,
      y: 20,
      toX: 110,
      toY: 220,
    })

    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe('drag from 10,20 to 110,220')
    const calls = sendMouse.mock.calls
    const moves = calls.slice(1, -1)
    expect(calls[0]).toEqual(['down', 10, 20, 'left', []])
    expect(moves.length).toBeGreaterThanOrEqual(1)
    expect(moves.at(-1)).toEqual(['move', 110, 220, 'left', []])
    expect(calls.at(-1)).toEqual(['up', 110, 220, 'left', []])
    expect(calls.map((call) => call[0])).toEqual(['down', ...moves.map(() => 'move'), 'up'])
  })

  it('rejects pointer input outside the viewport without sending it', async () => {
    const g = guest()
    const sendMouse = vi.fn()
    g.sendMouse = sendMouse
    const service = new BrowserService(() => g, vi.fn())

    const atRightEdge = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'drag',
      x: 800,
      y: 10,
      toX: 10,
      toY: 10,
    })
    expect(atRightEdge.isError).toBe(true)
    expect(text(atRightEdge)).toContain('800,10 is outside the 800x600 viewport')

    const atBottomEdge = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'click',
      x: 10,
      y: 600,
    })
    expect(atBottomEdge.isError).toBe(true)
    expect(text(atBottomEdge)).toContain('10,600 is outside the 800x600 viewport')

    const outsideEnd = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'drag',
      x: 10,
      y: 10,
      toX: 5000,
      toY: 20,
    })
    expect(outsideEnd.isError).toBe(true)
    expect(text(outsideEnd)).toContain('outside the 800x600 viewport')
    expect(sendMouse).not.toHaveBeenCalled()
  })

  it('passes modifiers to mouse and key input', async () => {
    const g = guest()
    const sendMouse = vi.fn()
    const sendKey = vi.fn()
    g.sendMouse = sendMouse
    g.sendKey = sendKey
    const service = new BrowserService(() => g, vi.fn())

    await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'down',
      x: 10,
      y: 20,
      modifiers: ['shift'],
    })
    expect(sendMouse).toHaveBeenCalledWith('down', 10, 20, 'left', ['shift'])

    await dispatchBrowserMcpTool(service, 'browser_key', {
      key: 'a',
      holdMs: 0,
      modifiers: ['shift'],
    })
    expect(sendKey).toHaveBeenCalledWith('a', 'down', ['shift'])
    expect(sendKey).toHaveBeenCalledWith('a', 'up', ['shift'])
  })

  it('rejects an unknown modifier without sending input', async () => {
    const g = guest()
    const sendMouse = vi.fn()
    const sendKey = vi.fn()
    g.sendMouse = sendMouse
    g.sendKey = sendKey
    const service = new BrowserService(() => g, vi.fn())

    const pointer = await dispatchBrowserMcpTool(service, 'browser_pointer', {
      action: 'click',
      x: 1,
      y: 2,
      modifiers: ['hyper'],
    })
    expect(pointer.isError).toBe(true)

    const key = await dispatchBrowserMcpTool(service, 'browser_key', {
      key: 'a',
      holdMs: 0,
      modifiers: ['hyper'],
    })
    expect(key.isError).toBe(true)
    expect(sendMouse).not.toHaveBeenCalled()
    expect(sendKey).not.toHaveBeenCalled()
  })
})

describe('writeBrowserMcpProxy', () => {
  it('writes a stdio proxy the ACP agent can spawn', async () => {
    const dir = tempDir('ari-mcp-')
    const path = await writeBrowserMcpProxy(dir)
    const source = await readFile(path, 'utf8')
    expect(source).toContain('ARI_BROWSER_MCP_URL')
    expect(source).toContain('fetch(url')
  })
})

async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: { type: string; text?: string }[] }> {
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
  const body = (await response.json()) as { result: { content: { type: string; text?: string }[] } }
  return body.result
}

describe('startBrowserMcpServer', () => {
  it('gives two sessions their own tab', async () => {
    const guests = new Map<string, BrowserGuest>()
    let destroyed = 0
    const service = new BrowserService((id) => {
      const created = guest()
      created.destroy = vi.fn(() => {
        destroyed += 1
      })
      guests.set(id, created)
      return created
    }, vi.fn())
    const handle = await startBrowserMcpServer(service)
    const first = handle.tokenFor('sess-a')
    const second = handle.tokenFor('sess-b')
    try {
      expect(first).not.toBe(handle.token)
      expect(first).not.toBe(second)
      const navA = await callTool(handle.url, first, 'browser_navigate', { url: 'a.example' })
      expect(navA.content[0]?.text).toContain('a.example')
      const navB = await callTool(handle.url, second, 'browser_navigate', { url: 'b.example' })
      expect(navB.content[0]?.text).toContain('b.example')
      const statusA = await callTool(handle.url, first, 'browser_status')
      expect(statusA.content[0]?.text).toContain('a.example')
      const statusB = await callTool(handle.url, second, 'browser_status')
      expect(statusB.content[0]?.text).toContain('b.example')
      expect([...guests.keys()].sort()).toEqual(['agent:sess-a', 'agent:sess-b'])

      handle.revoke('sess-a')
      const revoked = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${first}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      })
      expect(revoked.status).toBe(401)
      expect(destroyed).toBe(1)
    } finally {
      handle.close()
    }
  })

  it('reads state from the calling session tab only', async () => {
    const service = new BrowserService(
      (id) => pageGuest({ __ari: { state: () => ({ tab: id }) } }),
      vi.fn(),
    )
    const handle = await startBrowserMcpServer(service)
    try {
      const a = await callTool(handle.url, handle.tokenFor('sess-a'), 'browser_state')
      const b = await callTool(handle.url, handle.tokenFor('sess-b'), 'browser_state')
      expect(a.content[0]?.text).toBe('{"tab":"agent:sess-a"}')
      expect(b.content[0]?.text).toBe('{"tab":"agent:sess-b"}')
    } finally {
      handle.close()
    }
  })

  it('routes pointer input to its session tab', async () => {
    const guests = new Map<string, BrowserGuest>()
    const service = new BrowserService((id) => {
      const created = guest()
      guests.set(id, created)
      return created
    }, vi.fn())
    const handle = await startBrowserMcpServer(service)
    const first = handle.tokenFor('sess-a')
    const second = handle.tokenFor('sess-b')
    try {
      await callTool(handle.url, second, 'browser_status')
      const result = await callTool(handle.url, first, 'browser_pointer', {
        action: 'click',
        x: 10,
        y: 20,
      })
      expect(result.content[0]?.text).toBe('click at 10,20')
      expect(guests.get('agent:sess-a')?.sendMouse).toHaveBeenCalledTimes(2)
      expect(guests.get('agent:sess-b')?.sendMouse).not.toHaveBeenCalled()
    } finally {
      handle.close()
    }
  })

  it('reveals the pane only for inspector navigation, never for an agent tab', async () => {
    const onUpdated = vi.fn()
    const service = new BrowserService(() => guest(), onUpdated)
    const handle = await startBrowserMcpServer(service)
    try {
      await callTool(handle.url, handle.tokenFor('sess-a'), 'browser_navigate', {
        url: 'a.example',
      })
      expect(onUpdated).not.toHaveBeenCalledWith(expect.objectContaining({ reveal: true }))
      await callTool(handle.url, handle.token, 'browser_navigate', { url: 'b.example' })
      expect(onUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'inspector', reveal: true }),
      )
    } finally {
      handle.close()
    }
  })

  it('refuses a request whose token was revoked while its body was in flight', async () => {
    const opened: string[] = []
    const service = new BrowserService((id) => {
      opened.push(id)
      return guest()
    }, vi.fn())
    const handle = await startBrowserMcpServer(service)
    const token = handle.tokenFor('sess-a')
    try {
      await callTool(handle.url, token, 'browser_status')
      expect(opened).toEqual(['agent:sess-a'])
      const status = new Promise<number>((resolve, reject) => {
        const req = request(handle.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        })
        req.on('response', (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.flushHeaders()
        // Headers first: the server authorizes on them, then waits for the body.
        setTimeout(() => {
          handle.revoke('sess-a')
          req.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'browser_status', arguments: {} },
            }),
          )
        }, 50)
      })
      expect(await status).toBe(401)
      expect(opened).toEqual(['agent:sess-a'])
      expect(service.has('agent:sess-a')).toBe(false)
    } finally {
      handle.close()
    }
  })

  it('keeps the legacy app-wide token on the inspector tab', async () => {
    const ids: string[] = []
    const service = new BrowserService((id) => {
      ids.push(id)
      return guest()
    }, vi.fn())
    const handle = await startBrowserMcpServer(service)
    try {
      const status = await callTool(handle.url, handle.token, 'browser_status')
      expect(status.content[0]?.text).toContain('about:blank')
      expect(ids).toEqual(['inspector'])
    } finally {
      handle.close()
    }
  })

  it('rejects an unknown bearer token', async () => {
    const service = new BrowserService(() => guest(), vi.fn())
    const handle = await startBrowserMcpServer(service)
    try {
      const response = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(response.status).toBe(401)
    } finally {
      handle.close()
    }
  })

  it('serves tools/list over authorized HTTP', async () => {
    const service = new BrowserService(() => guest(), vi.fn())
    const handle = await startBrowserMcpServer(service)
    try {
      const denied = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(denied.status).toBe(401)
      const ok = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { result?: { tools?: { name: string }[] } }
      expect(body.result?.tools?.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'browser_navigate',
          'browser_screenshot',
          'browser_key',
          'browser_state',
          'browser_pointer',
        ]),
      )
    } finally {
      handle.close()
    }
  })
})
