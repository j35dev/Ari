import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserService, type BrowserGuest } from './browser-service'
import { dispatchBrowserMcpTool, startBrowserMcpServer, writeBrowserMcpProxy } from './browser-mcp'
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
      return { url, title: 'Example', text: 'hi', elements: [] }
    }),
    capturePage: vi.fn(async () => null),
    consoleEntries: () => [],
    sendKey: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
  }
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
    expect(capturePage).toHaveBeenCalledWith(undefined, 'jpeg')
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
    expect(sendKey).toHaveBeenLastCalledWith('ArrowRight', 'down')
    await vi.advanceTimersByTimeAsync(499)
    expect(sendKey).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sendKey).toHaveBeenLastCalledWith('ArrowRight', 'up')
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
      ['a', 'down'],
      ['a', 'up'],
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
        expect.arrayContaining(['browser_navigate', 'browser_screenshot', 'browser_key']),
      )
    } finally {
      handle.close()
    }
  })
})
