import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createLogger } from '@ari/shared/logger'
import type { BrowserService } from './browser-service'
import { resolveBrowserUrl } from './browser-url'

const log = createLogger('desktop:browser-mcp')

const DEFAULT_TAB = 'inspector'

export interface BrowserMcpHandle {
  url: string
  /** App-wide token; still drives the shared inspector tab. */
  token: string
  /** A token whose tool calls act on this session's own tab. */
  tokenFor: (sessionId: string) => string
  /** Forgets a session's token and closes its tab. */
  revoke: (sessionId: string) => void
  close: () => void
}

interface JsonRpc {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

type BrowserMcpContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

interface BrowserMcpResult {
  content: BrowserMcpContent[]
  isError?: boolean
}

const MAX_KEY_HOLD_MS = 5000
const DEFAULT_KEY_HOLD_MS = 50
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

function textResult(text: string, isError = false): BrowserMcpResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

export const BROWSER_MCP_TOOLS = [
  {
    name: 'browser_status',
    description:
      "URL, title, and loading state of Ari's visible in-app browser. Prefer this over any other browser.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_navigate',
    description:
      "Open a URL in Ari's visible in-app browser (http/https). The user sees this page. Use this instead of any other browser, web fetch, or computer-use tool.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL or host[:port]' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Page text, interactive elements (tag, selector, label), and recent console warnings/errors from the in-app browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_click',
    description: 'Click the first element matching a CSS selector in the in-app browser.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description: 'Type into the first element matching a CSS selector in the in-app browser.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'JPEG screenshot of the in-app browser page. Use it to see canvas, WebGL, or game content that browser_snapshot cannot read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_key',
    description:
      'Press a key in the in-app browser page: key down, hold for holdMs, key up. Use it to play or test games.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name, e.g. ArrowRight, ArrowUp, Space, Enter, Escape, a',
        },
        holdMs: {
          type: 'number',
          description: `How long to hold the key, 0-${String(MAX_KEY_HOLD_MS)} ms (default ${String(DEFAULT_KEY_HOLD_MS)})`,
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
] as const

export async function dispatchBrowserMcpTool(
  browsers: BrowserService,
  name: string,
  args: Record<string, unknown>,
  tabId = DEFAULT_TAB,
): Promise<BrowserMcpResult> {
  try {
    if (!browsers.has(tabId)) await browsers.open(tabId)
    if (name === 'browser_status') {
      return textResult(JSON.stringify(browsers.snapshot(tabId)))
    }
    if (name === 'browser_navigate') {
      const url = typeof args['url'] === 'string' ? args['url'] : ''
      const resolved = resolveBrowserUrl(url)
      if (!resolved.ok) return textResult(resolved.error, true)
      const result = await browsers.navigate(tabId, resolved.url)
      browsers.reveal(tabId)
      return result.ok ? textResult(JSON.stringify(result.tab)) : textResult(result.error, true)
    }
    if (name === 'browser_snapshot') {
      const snap = await browsers.pageSnapshot(tabId)
      // A playtest rarely needs `console.log`, but a warning or an uncaught
      // error is often the only visible sign that a page broke.
      const consoleEntries = browsers
        .consoleEntries(tabId)
        .filter((entry) => entry.level === 'warning' || entry.level === 'error')
      const page =
        snap !== null && typeof snap === 'object' && !Array.isArray(snap)
          ? snap
          : { snapshot: snap }
      return textResult(JSON.stringify({ ...page, consoleEntries }))
    }
    if (name === 'browser_click') {
      const selector = typeof args['selector'] === 'string' ? args['selector'] : ''
      if (!selector) return textResult('selector is required', true)
      const clicked = await browsers.runScript(
        tabId,
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
      )
      return clicked === true
        ? textResult('clicked')
        : textResult(`no element for ${selector}`, true)
    }
    if (name === 'browser_type') {
      const selector = typeof args['selector'] === 'string' ? args['selector'] : ''
      const text = typeof args['text'] === 'string' ? args['text'] : ''
      if (!selector) return textResult('selector is required', true)
      const typed = await browsers.runScript(
        tabId,
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); if ('value' in el) el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
      )
      return typed === true ? textResult('typed') : textResult(`no element for ${selector}`, true)
    }
    if (name === 'browser_screenshot') {
      const still = await browsers.still(tabId)
      if (still === null) return textResult('screenshot failed: the page returned no image', true)
      return {
        content: [
          { type: 'image', data: still.slice(JPEG_DATA_URL_PREFIX.length), mimeType: 'image/jpeg' },
        ],
      }
    }
    if (name === 'browser_key') {
      const key = typeof args['key'] === 'string' ? args['key'] : ''
      if (!key) return textResult('key is required', true)
      const hold = typeof args['holdMs'] === 'number' ? args['holdMs'] : DEFAULT_KEY_HOLD_MS
      const holdMs = Math.min(MAX_KEY_HOLD_MS, Math.max(0, Number.isFinite(hold) ? hold : 0))
      await browsers.key(tabId, key, holdMs)
      return textResult(`pressed ${key} for ${String(holdMs)}ms`)
    }
    return textResult(`unknown tool ${name}`, true)
  } catch (error: unknown) {
    return textResult(error instanceof Error ? error.message : String(error), true)
  }
}

/** The tab a bearer token may drive; null when the token is not ours. */
function authorizedTab(req: IncomingMessage, tabs: ReadonlyMap<string, string>): string | null {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const tab = tabs.get(header.slice('Bearer '.length))
    if (tab !== undefined) return tab
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const query = url.searchParams.get('token')
  return query === null ? null : (tabs.get(query) ?? null)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleRpc(
  browsers: BrowserService,
  message: JsonRpc,
  tabId = DEFAULT_TAB,
): Promise<{
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}> {
  const id = message.id
  const method = message.method ?? ''
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ari-browser', version: '0.1.0' },
        instructions:
          "You are connected to Ari's in-app browser. The user can see the page. Use browser_navigate, browser_snapshot, browser_click, and browser_type for every web task, and browser_screenshot and browser_key to see and play canvas or game pages. Never say a browser is unavailable and do not use a separate browser or computer-use tool.",
      },
    }
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { jsonrpc: '2.0', id }
  }
  if (method === 'ping' || method === 'tools/list') {
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    return { jsonrpc: '2.0', id, result: { tools: BROWSER_MCP_TOOLS } }
  }
  if (method === 'tools/call') {
    const params = asRecord(message.params)
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    const args = asRecord(params['arguments'])
    const result = await dispatchBrowserMcpTool(browsers, name, args, tabId)
    return { jsonrpc: '2.0', id, result }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}

/** Loopback Streamable HTTP MCP for the in-app browser. */
export function startBrowserMcpServer(browsers: BrowserService): Promise<BrowserMcpHandle> {
  const token = randomBytes(24).toString('base64url')
  // token -> tab. The app-wide token keeps the shared inspector tab; every
  // session gets its own token, so two agents never drive the same page.
  const tabs = new Map<string, string>([[token, DEFAULT_TAB]])
  const sessionTokens = new Map<string, string>()
  const tokenFor = (sessionId: string): string => {
    const existing = sessionTokens.get(sessionId)
    if (existing !== undefined) return existing
    const next = randomBytes(24).toString('base64url')
    tabs.set(next, `agent:${sessionId}`)
    sessionTokens.set(sessionId, next)
    return next
  }
  const revoke = (sessionId: string): void => {
    const existing = sessionTokens.get(sessionId)
    if (existing === undefined) return
    tabs.delete(existing)
    sessionTokens.delete(sessionId)
    browsers.close(`agent:${sessionId}`)
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      const tabId = authorizedTab(req, tabs)
      if (tabId === null) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'POST required' })
        return
      }
      let parsed: JsonRpc
      try {
        parsed = JSON.parse(await readBody(req)) as JsonRpc
      } catch {
        json(res, 400, { error: 'invalid json' })
        return
      }
      if (parsed.id === undefined) {
        void handleRpc(browsers, parsed, tabId)
        res.writeHead(202)
        res.end()
        return
      }
      json(res, 200, await handleRpc(browsers, parsed, tabId))
    })().catch((error: unknown) => {
      log.warn('browser mcp request failed', { error: String(error) })
      if (!res.headersSent) json(res, 500, { error: 'internal' })
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('browser mcp failed to bind'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/mcp`,
        token,
        tokenFor,
        revoke,
        close: () => server.close(),
      })
    })
  })
}

/**
 * ACP requires stdio MCP. This proxy is spawned with ELECTRON_RUN_AS_NODE
 * and forwards JSON-RPC lines to the loopback HTTP server.
 */
const MCP_PROXY_SOURCE = [
  "import { createInterface } from 'node:readline'",
  "import { stdin, stdout } from 'node:process'",
  'const url = process.env.ARI_BROWSER_MCP_URL',
  'const token = process.env.ARI_BROWSER_MCP_TOKEN',
  'async function rpc(msg) {',
  '  const res = await fetch(url, {',
  "    method: 'POST',",
  "    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },",
  '    body: JSON.stringify(msg),',
  '  })',
  '  if (res.status === 202) return null',
  '  return await res.json()',
  '}',
  'const rl = createInterface({ input: stdin })',
  "rl.on('line', (line) => {",
  '  if (!line.trim()) return',
  '  const msg = JSON.parse(line)',
  '  rpc(msg).then((out) => {',
  "    if (out && msg.id !== undefined) stdout.write(JSON.stringify(out) + '\\n')",
  '  }).catch((err) => {',
  '    if (msg.id !== undefined) {',
  "      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } }) + '\\n')",
  '    }',
  '  })',
  '})',
].join('\n')

export async function writeBrowserMcpProxy(dir: string): Promise<string> {
  const path = join(dir, 'browser-mcp-proxy.mjs')
  await writeFile(path, MCP_PROXY_SOURCE, 'utf8')
  return path
}
