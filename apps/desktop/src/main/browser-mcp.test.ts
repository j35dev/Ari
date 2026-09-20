import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserService, type BrowserGuest } from './browser-service'
import { dispatchBrowserMcpTool, startBrowserMcpServer, writeBrowserMcpProxy } from './browser-mcp'

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
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('dispatchBrowserMcpTool', () => {
  it('navigates and snapshots the shared guest', async () => {
    const service = new BrowserService(() => guest(), vi.fn())
    const nav = await dispatchBrowserMcpTool(service, 'browser_navigate', { url: 'example.com' })
    expect(nav.isError).toBeUndefined()
    expect(nav.content[0]?.text).toContain('https://example.com')
    const snap = await dispatchBrowserMcpTool(service, 'browser_snapshot', {})
    expect(snap.content[0]?.text).toContain('Example')
    const bad = await dispatchBrowserMcpTool(service, 'browser_navigate', { url: 'file:///x' })
    expect(bad.isError).toBe(true)
  })
})

describe('writeBrowserMcpProxy', () => {
  it('writes a stdio proxy the ACP agent can spawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-mcp-'))
    const path = await writeBrowserMcpProxy(dir)
    const source = await readFile(path, 'utf8')
    expect(source).toContain('ARI_BROWSER_MCP_URL')
    expect(source).toContain('fetch(url')
  })
})

describe('startBrowserMcpServer', () => {
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
      expect(body.result?.tools?.map((t) => t.name)).toContain('browser_navigate')
    } finally {
      handle.close()
    }
  })
})
