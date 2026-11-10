import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow } from 'electron'
import { hostedBrowserGuestFactory } from '../browser-electron'
import { startBrowserMcpServer } from '../browser-mcp'
import { BrowserService, type BrowserGuest } from '../browser-service'

// Real-Electron check that browser_pointer and browser_key input to an offscreen
// agent tab shows up in browser_state, and only in that tab. Run under a display:
// `xvfb-run -a pnpm --filter @ari/desktop e2e`.

// Input reaches the game only through a requestAnimationFrame loop, so it needs
// the agent tab to keep rendering offscreen (#432). Chromium drops input sent
// before a document's first contentful paint, so state() waits for that paint
// and every input in this run comes after a state read.
const FIXTURE = `<!doctype html>
<html><body><p>browser_state input fixture</p><script>
const tab = new URLSearchParams(location.search).get('tab')
const state = { player: { x: 0 }, clicks: 0, lastPointer: null }
const pending = []
let frames = 0
addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') pending.push({ type: 'key' })
})
addEventListener('pointerdown', (event) => {
  pending.push({ type: 'pointer', x: event.clientX, y: event.clientY })
})
function frame() {
  frames++
  for (const item of pending.splice(0)) {
    if (item.type === 'key') state.player.x += 1
    else {
      state.clicks += 1
      state.lastPointer = { x: item.x, y: item.y }
    }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
const painted = new Promise((resolve) => {
  new PerformanceObserver((list, observer) => {
    if (list.getEntriesByName('first-contentful-paint').length === 0) return
    observer.disconnect()
    resolve()
  }).observe({ type: 'paint', buffered: true })
})
window.__ari = {
  state: async () => {
    await painted
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return { tab, ...structuredClone(state) }
  },
}
window.__fixtureDiagnostics = () => ({ tab, frames, readyState: document.readyState,
  hidden: document.hidden, paint: performance.getEntriesByType('paint').map(p => p.name) })
</script></body></html>`

interface ToolResponse {
  result?: { content?: { text?: string }[]; isError?: boolean }
}

async function main(): Promise<void> {
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE)
  })
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${String((fixture.address() as AddressInfo).port)}`

  await app.whenReady()
  const win = new BrowserWindow({ width: 1200, height: 800 })
  const guests = new Map<string, BrowserGuest>()
  const createGuest = hostedBrowserGuestFactory(win.webContents)
  const browsers = new BrowserService(
    (id, updated) => {
      const guest = createGuest(id, updated)
      guests.set(id, guest)
      return guest
    },
    () => {},
  )
  const mcp = await startBrowserMcpServer(browsers)

  const callTool = async (
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const { result } = (await res.json()) as ToolResponse
    const text = result?.content?.[0]?.text ?? ''
    if (result?.isError === true || text === '') throw new Error(`${name} failed: ${text}`)
    return text
  }
  const state = async (token: string): Promise<unknown> => {
    try {
      return JSON.parse(await callTool(token, 'browser_state'))
    } catch (error) {
      // Observe the failed first-paint/rAF boundary without retrying the tool,
      // changing its timeout, or exposing authentication tokens in CI logs.
      for (const [id, guest] of guests) {
        try {
          console.error(
            'E2E state diagnostics',
            id,
            await guest.executeJavaScript(
              'window.__fixtureDiagnostics?.() ?? {readyState:document.readyState, missingFixture:true}',
            ),
          )
        } catch (diagnosticError) {
          console.error('E2E diagnostics failed', id, String(diagnosticError))
        }
      }
      throw error
    }
  }

  const a = mcp.tokenFor('a')
  const b = mcp.tokenFor('b')
  await callTool(a, 'browser_navigate', { url: `${base}/?tab=a` })
  await callTool(b, 'browser_navigate', { url: `${base}/?tab=b` })

  const freshA = { tab: 'a', player: { x: 0 }, clicks: 0, lastPointer: null }
  const freshB = { tab: 'b', player: { x: 0 }, clicks: 0, lastPointer: null }
  assert.deepEqual(await state(a), freshA)
  assert.deepEqual(await state(b), freshB)
  assert.deepEqual(await state(a), freshA, 'state changed with no input')

  await callTool(a, 'browser_pointer', { action: 'click', x: 40, y: 30 })
  const clickedA = { ...freshA, clicks: 1, lastPointer: { x: 40, y: 30 } }
  assert.deepEqual(await state(a), clickedA)
  assert.deepEqual(await state(b), freshB, 'a click on tab a reached tab b')

  await callTool(a, 'browser_key', { key: 'ArrowRight' })
  await callTool(a, 'browser_key', { key: 'ArrowRight' })
  const movedA = { ...clickedA, player: { x: 2 } }
  assert.deepEqual(await state(a), movedA)
  assert.deepEqual(await state(b), freshB, 'a key on tab a reached tab b')

  await callTool(b, 'browser_pointer', { action: 'click', x: 100, y: 50 })
  await callTool(b, 'browser_key', { key: 'ArrowRight' })
  assert.deepEqual(await state(b), {
    ...freshB,
    player: { x: 1 },
    clicks: 1,
    lastPointer: { x: 100, y: 50 },
  })
  assert.deepEqual(await state(a), movedA, 'input to tab b reached tab a')
}

const watchdog = setTimeout(() => {
  console.error('E2E FAIL: no result within 60 s')
  app.exit(1)
}, 60_000)

main().then(
  () => {
    clearTimeout(watchdog)
    console.log('E2E PASS browser_state input')
    app.exit(0)
  },
  (error: unknown) => {
    clearTimeout(watchdog)
    console.error('E2E FAIL', error)
    app.exit(1)
  },
)
