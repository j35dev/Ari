import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createLogger } from '@ari/shared/logger'
import {
  KEY_MODIFIERS,
  POINTER_ACTIONS,
  POINTER_BUTTONS,
  type BrowserService,
  type KeyModifier,
} from './browser-service'
import {
  clockSource,
  clockText,
  DEFAULT_CLOCK_FPS,
  freezeClock,
  MAX_CLOCK_FPS,
  MAX_CLOCK_STEP_MS,
} from './browser-clock-script'
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
/** browser_state output longer than this is cut, with a marker saying how much was dropped. */
export const MAX_BROWSER_STATE_CHARS = 20_000
/** browser_state fails if window.__ari.state() has not settled by then. */
export const BROWSER_STATE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MESSAGE = `window.__ari.state() did not settle within ${String(BROWSER_STATE_TIMEOUT_MS / 1000)} s. A hook that waits for requestAnimationFrame never settles while the tab isn't rendering.`
// Fixed on purpose: browser_state never runs caller-supplied code. The page
// cuts the JSON to the cap itself so an oversized state never crosses IPC,
// and reports the full length so the tool can say how much was dropped. The
// time limit is enforced in the main process (withTimeout), since a page can
// replace setTimeout and Promise.race.
const STATE_SOURCE = `(async () => {
  const ari = window.__ari
  if (!ari || typeof ari.state !== 'function') return { hook: false }
  const out = JSON.stringify(await ari.state())
  const json = out === undefined ? 'null' : out
  const cap = ${String(MAX_BROWSER_STATE_CHARS)}
  if (json.length <= cap) return { hook: true, json, length: json.length }
  const last = json.charCodeAt(cap - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap
  return { hook: true, json: json.slice(0, end), length: json.length }
})()`
const NO_STATE_HOOK =
  'This page has no window.__ari.state() hook. Ask the game to expose window.__ari = { state: () => ({ ... }) } returning JSON-serializable state, or use browser_screenshot.'

function stateText(result: unknown): string {
  const { hook, json, length } = asRecord(result)
  if (hook !== true || typeof json !== 'string') return NO_STATE_HOOK
  // The page already cut it; cut again in case the page tampered with the script's builtins.
  const kept = json.length <= MAX_BROWSER_STATE_CHARS ? json : cutAtCap(json)
  const reported = typeof length === 'number' && Number.isFinite(length) ? length : 0
  const total = Math.max(reported, json.length)
  if (total <= kept.length) return kept
  const dropped = total - kept.length
  return `${kept}…[truncated ${String(dropped)} of ${String(total)} chars]`
}

/** Cuts to the cap, backing off one unit rather than splitting a surrogate pair. */
function cutAtCap(json: string): string {
  const last = json.charCodeAt(MAX_BROWSER_STATE_CHARS - 1)
  const end =
    last >= 0xd800 && last <= 0xdbff ? MAX_BROWSER_STATE_CHARS - 1 : MAX_BROWSER_STATE_CHARS
  return json.slice(0, end)
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const MODIFIERS_SCHEMA = {
  type: 'array',
  items: { type: 'string', enum: KEY_MODIFIERS },
  description: 'Modifier keys held during the input',
} as const

function textResult(text: string, isError = false): BrowserMcpResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Missing means none; anything but a list of known modifiers is null. */
function parseModifiers(value: unknown): KeyModifier[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  return value.every((item) => isOneOf(item, KEY_MODIFIERS)) ? value : null
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
      'JPEG screenshot of the in-app browser viewport, one image pixel per viewport CSS pixel, so x,y read off it are the coordinates browser_pointer takes. Use it to see canvas, WebGL, or game content that browser_snapshot cannot read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_state',
    description:
      "JSON from the page's window.__ari.state() hook, the cheap way to read game state without a screenshot. Output is capped and cut with a marker.",
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
        modifiers: MODIFIERS_SCHEMA,
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_pointer',
    description:
      'Pointer input in the in-app browser page at viewport CSS pixels: click, down, up, move, or drag from x,y to toX,toY. Use it for canvas or game pages that browser_click cannot reach.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: POINTER_ACTIONS },
        x: { type: 'number', description: 'Viewport CSS px from the left edge' },
        y: { type: 'number', description: 'Viewport CSS px from the top edge' },
        toX: { type: 'number', description: 'Drag end x; required for drag' },
        toY: { type: 'number', description: 'Drag end y; required for drag' },
        button: { type: 'string', enum: POINTER_BUTTONS, description: 'Default left' },
        modifiers: MODIFIERS_SCHEMA,
      },
      required: ['action', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_clock',
    description:
      'Freeze, step, or resume the page clock (requestAnimationFrame, performance.now, Date.now) so a running game holds still while you observe it. step advances virtual time by ms and runs queued animation frames at fps. Timers and audio are not frozen; navigating drops the freeze.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['freeze', 'step', 'resume'] },
        ms: {
          type: 'number',
          description: `step only: virtual time to advance, 1-${String(MAX_CLOCK_STEP_MS)} ms`,
        },
        fps: {
          type: 'number',
          description: `step only: frames per second, 1-${String(MAX_CLOCK_FPS)} (default ${String(DEFAULT_CLOCK_FPS)})`,
        },
      },
      required: ['action'],
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
      // The pane shows only the inspector; an agent tab revealing would open it on the wrong page.
      if (tabId === DEFAULT_TAB) browsers.reveal(tabId)
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
      if (!selector) return textResult('selector is required', true)
      if (typeof args['text'] !== 'string') return textResult('text must be a string', true)
      const text = args['text']
      const typed = await browsers.runScript(
        tabId,
        `(() => {
          const selector = ${JSON.stringify(selector)}
          const text = ${JSON.stringify(text)}
          const el = document.querySelector(selector)
          if (!el) return 'no element for ' + selector
          if (!(el instanceof HTMLElement)) return 'unsupported element for ' + selector
          if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') {
            return 'element is disabled for ' + selector
          }
          if (el.getAttribute('aria-readonly') === 'true') return 'element is read-only for ' + selector
          const input = el instanceof HTMLInputElement
          const textarea = el instanceof HTMLTextAreaElement
          if (input || textarea) {
            if (el.readOnly) return 'element is read-only for ' + selector
            if (input && !['text', 'search', 'tel', 'url', 'email', 'password'].includes(el.type)) {
              return 'unsupported input type ' + el.type + ' for ' + selector
            }
            el.focus()
            // Bypass React's own value setter so its input handler sees the change.
            const prototype = input ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
            const previous = el.value
            setter.call(el, text)
            if (el.value !== text) {
              setter.call(el, previous)
              return 'element rejected the text for ' + selector
            }
          } else {
            let editable = false
            for (let node = el; node; node = node.parentElement) {
              const value = node.getAttribute('contenteditable')
              if (value === null) continue
              const mode = value.toLowerCase()
              if (!['', 'true', 'false', 'plaintext-only'].includes(mode)) continue
              editable = mode !== 'false'
              break
            }
            if (!editable) return 'element is not editable for ' + selector
            el.focus()
            el.textContent = text
          }
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, composed: true, inputType: 'insertReplacementText', data: text,
          }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()`,
      )
      return typed === true
        ? textResult('typed')
        : textResult(typeof typed === 'string' ? typed : `could not fill ${selector}`, true)
    }
    if (name === 'browser_state') {
      const state = await withTimeout(
        browsers.runScript(tabId, STATE_SOURCE),
        BROWSER_STATE_TIMEOUT_MS,
        STATE_TIMEOUT_MESSAGE,
      )
      return textResult(stateText(state))
    }
    if (name === 'browser_screenshot') {
      const still = await browsers.screenshot(tabId)
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
      const modifiers = parseModifiers(args['modifiers'])
      if (modifiers === null) {
        return textResult(`modifiers must be ${KEY_MODIFIERS.join(', ')}`, true)
      }
      const hold = typeof args['holdMs'] === 'number' ? args['holdMs'] : DEFAULT_KEY_HOLD_MS
      const holdMs = Math.min(MAX_KEY_HOLD_MS, Math.max(0, Number.isFinite(hold) ? hold : 0))
      await browsers.key(tabId, key, holdMs, modifiers)
      return textResult(`pressed ${key} for ${String(holdMs)}ms`)
    }
    if (name === 'browser_pointer') {
      const action = args['action']
      if (!isOneOf(action, POINTER_ACTIONS)) {
        return textResult(`action must be ${POINTER_ACTIONS.join(', ')}`, true)
      }
      const button = args['button'] ?? 'left'
      if (!isOneOf(button, POINTER_BUTTONS)) {
        return textResult(`button must be ${POINTER_BUTTONS.join(', ')}`, true)
      }
      const modifiers = parseModifiers(args['modifiers'])
      if (modifiers === null) {
        return textResult(`modifiers must be ${KEY_MODIFIERS.join(', ')}`, true)
      }
      const x = finiteNumber(args['x'])
      const y = finiteNumber(args['y'])
      if (x === null || y === null) return textResult('x and y must be numbers', true)
      if (action !== 'drag') {
        await browsers.pointer(tabId, { action, x, y, button, modifiers })
        return textResult(`${action} at ${String(x)},${String(y)}`)
      }
      const toX = finiteNumber(args['toX'])
      const toY = finiteNumber(args['toY'])
      if (toX === null || toY === null) return textResult('drag needs toX and toY', true)
      await browsers.pointer(tabId, { action, x, y, to: { x: toX, y: toY }, button, modifiers })
      return textResult(`drag from ${String(x)},${String(y)} to ${String(toX)},${String(toY)}`)
    }
    if (name === 'browser_clock') {
      const action = args['action']
      if (action !== 'freeze' && action !== 'step' && action !== 'resume') {
        return textResult('action must be freeze, step, or resume', true)
      }
      const ms = typeof args['ms'] === 'number' ? args['ms'] : 0
      const fps = typeof args['fps'] === 'number' ? args['fps'] : DEFAULT_CLOCK_FPS
      if (action === 'step' && !(ms >= 1 && ms <= MAX_CLOCK_STEP_MS)) {
        return textResult(`ms must be a number from 1 to ${String(MAX_CLOCK_STEP_MS)}`, true)
      }
      if (action === 'step' && !(fps >= 1 && fps <= MAX_CLOCK_FPS)) {
        return textResult(`fps must be a number from 1 to ${String(MAX_CLOCK_FPS)}`, true)
      }
      const raw =
        action === 'freeze'
          ? await freezeClock(
              (code) => browsers.runScript(tabId, code),
              () => browsers.still(tabId),
            )
          : await browsers.runScript(tabId, clockSource(action, ms, fps))
      const result = clockText(action, ms, fps, raw)
      return textResult(result.text, result.isError)
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
          "You are connected to Ari's in-app browser. The user can see the page. Use browser_navigate, browser_snapshot, browser_click, and browser_type for every web task, and browser_state, browser_screenshot, browser_key, browser_pointer, and browser_clock to see and play canvas or game pages. Prefer browser_state over a screenshot when the page exposes window.__ari.state(). Never say a browser is unavailable and do not use a separate browser or computer-use tool.",
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
      // A revoke while the body was in flight must not reopen the closed tab.
      if (authorizedTab(req, tabs) !== tabId) {
        json(res, 401, { error: 'unauthorized' })
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
