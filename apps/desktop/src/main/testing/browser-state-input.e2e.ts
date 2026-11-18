import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, BrowserWindow, nativeImage, WebContentsView } from 'electron'
import { hostedBrowserGuestFactory, INPUT_FOCUS_HOLD_MS } from '../browser-electron'
import { startBrowserMcpServer } from '../browser-mcp'
import { BrowserService, type BrowserGuest } from '../browser-service'
import { checkNativeBrowserInput } from './browser-native-input'

// Real-Electron check for background automation and the same native page docked
// for user interaction. Run under a display:
// `xvfb-run -a pnpm --filter @ari/desktop e2e`.

// Input reaches the game only through a requestAnimationFrame loop, so it needs
// the agent tab to keep rendering while hidden (#432). Hidden native pages do
// not necessarily expose first-contentful-paint entries. Verify an actual drawn
// capture before sending input, and let state() wait for the page's frame loop.
const FIXTURE = `<!doctype html>
<html><body style="background:#eaf2ff"><p>browser_state input fixture</p>
<input id="field" aria-label="Native browser input"><div style="height:2000px">Scrollable page</div><script>
const tab = new URLSearchParams(location.search).get('tab')
const state = { player: { x: 0 }, clicks: 0, lastPointer: null }
const pending = []
let frames = 0
const held = new Set()
let blurredWhileHeld = 0
addEventListener('keydown', (event) => {
  held.add(event.key)
  if (event.key === 'ArrowRight') pending.push({ type: 'key' })
})
addEventListener('keyup', (event) => held.delete(event.key))
addEventListener('blur', () => {
  if (held.size > 0) blurredWhileHeld++
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
window.__ari = {
  state: async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return { tab, ...structuredClone(state) }
  },
}
window.__blurredWhileHeld = () => blurredWhileHeld
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
  win.removeMenu()
  await win.loadURL(
    'data:text/html,<body style="background:rgb(255,255,255)">Ari browser test shell</body>',
  )
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

  for (const id of ['agent:a', 'agent:b']) {
    const capture = await browsers.screenshot(id)
    assert.ok(capture, `${id} has no rendered capture`)
    const image = nativeImage.createFromDataURL(capture)
    assert.deepEqual(image.getSize(), { width: 800, height: 600 })
    const pixels = image.toBitmap()
    const offset = (400 * 800 + 600) * 4
    const expected = [255, 242, 234]
    for (const [channel, value] of expected.entries()) {
      const actual = pixels[offset + channel]
      assert.ok(
        actual !== undefined && Math.abs(actual - value) <= 5,
        `${id} captured an unpainted page`,
      )
    }
  }

  const freshA = { tab: 'a', player: { x: 0 }, clicks: 0, lastPointer: null }
  const freshB = { tab: 'b', player: { x: 0 }, clicks: 0, lastPointer: null }
  assert.deepEqual(await state(a), freshA)
  assert.deepEqual(await state(b), freshB)
  assert.deepEqual(await state(a), freshA, 'state changed with no input')

  await callTool(a, 'browser_pointer', { action: 'click', x: 40, y: 30 })
  const clickedA = { ...freshA, clicks: 1, lastPointer: { x: 40, y: 30 } }
  assert.deepEqual(await state(a), clickedA)
  assert.deepEqual(await state(b), freshB, 'a click on tab a reached tab b')

  win.webContents.focus()
  await callTool(a, 'browser_key', { key: 'ArrowRight' })
  await callTool(a, 'browser_key', { key: 'ArrowRight' })
  const movedA = { ...clickedA, player: { x: 2 } }
  assert.deepEqual(await state(a), movedA)
  assert.deepEqual(await state(b), freshB, 'a key on tab a reached tab b')
  assert.equal(
    await guests.get('agent:a')?.executeJavaScript('window.__blurredWhileHeld()'),
    0,
    'hidden key input blurred the page while its key was held',
  )
  // Agent input lends the page the shell's focus only briefly.
  await new Promise((resolve) => setTimeout(resolve, INPUT_FOCUS_HOLD_MS + 200))
  if (win.isFocused()) assert.ok(win.webContents.isFocused(), 'agent input kept the shell focus')

  await callTool(b, 'browser_pointer', { action: 'click', x: 100, y: 50 })
  await callTool(b, 'browser_key', { key: 'ArrowRight' })
  assert.deepEqual(await state(b), {
    ...freshB,
    player: { x: 1 },
    clicks: 1,
    lastPointer: { x: 100, y: 50 },
  })
  assert.deepEqual(await state(a), movedA, 'input to tab b reached tab a')

  const page = win.contentView.children.find(
    (view) => view instanceof WebContentsView && view.webContents.getURL() === `${base}/?tab=a`,
  )
  assert.ok(page instanceof WebContentsView, 'agent has no native view')
  assert.equal(page.webContents.isOffscreen(), false, 'docked browser must accept native input')
  assert.ok(
    win.contentView.children.every((view) => !view.getVisible()),
    'background agent obscures shell',
  )
  const pageId = page.webContents.id
  await page.webContents.executeJavaScript('document.querySelector("#field").value = "unsaved"')

  const bounds = { x: 480, y: 80, width: 630, height: 420 }
  browsers.layout('agent:a', bounds, true)
  assert.equal(page.getVisible(), true, 'docked browser is not visible')
  assert.deepEqual(page.getBounds(), bounds)
  assert.deepEqual(await page.webContents.executeJavaScript('[innerWidth,innerHeight]'), [630, 420])
  const shot = await browsers.screenshot('agent:a')
  assert.ok(shot, 'native browser screenshot is empty')
  assert.deepEqual(nativeImage.createFromDataURL(shot).getSize(), { width: 630, height: 420 })

  await checkNativeBrowserInput(win, page)
  const persisted: unknown = await page.webContents.executeJavaScript(
    'document.querySelector("#field").value',
  )
  const afterInput = await state(a)
  // The panel stays placed when Ari goes to the tray. Its page must keep
  // responding to tools even though there is no visible native surface.
  win.hide()
  assert.deepEqual(
    await state(a),
    afterInput,
    'placed browser stopped rendering with a hidden host',
  )
  assert.ok(
    await browsers.screenshot('agent:a'),
    'placed browser cannot be captured with a hidden host',
  )
  win.show()
  browsers.layout('agent:a', { x: 0, y: 0, width: 0, height: 0 }, false)
  assert.equal(page.getVisible(), false, 'hidden browser obscures shell')
  assert.deepEqual(await state(a), afterInput, 'hiding the browser reset the page')

  // Throttling can start while a background tab is idle. Tool use must resume
  // its animation loop even after the entire window has gone to the tray.
  page.webContents.setBackgroundThrottling(true)
  win.hide()
  assert.deepEqual(await state(a), afterInput, 'tray-hidden browser cannot resume rendering')
  assert.ok(await browsers.screenshot('agent:a'), 'tray-hidden browser cannot be captured')
  win.show()

  const resized = { ...bounds, width: 400, height: 300 }
  browsers.layout('agent:a', resized, true)
  assert.equal(page.webContents.id, pageId, 'docking recreated the page')
  assert.equal(
    await page.webContents.executeJavaScript('document.querySelector("#field").value'),
    persisted,
  )
  assert.deepEqual(await page.webContents.executeJavaScript('[innerWidth,innerHeight]'), [400, 300])
  browsers.hideAll()
  assert.ok(
    win.contentView.children.every((view) => !view.getVisible()),
    'shell reset left browser on top',
  )
  const closingContents = page.webContents
  const destroyed = new Promise<void>((resolve) => closingContents.once('destroyed', resolve))
  mcp.revoke('a')
  mcp.revoke('b')
  await destroyed
  assert.equal(closingContents.isDestroyed(), true, 'closing the tab leaked its webContents')
  mcp.close()
  fixture.close()
  win.destroy()
}

const watchdog = setTimeout(() => {
  console.error('E2E FAIL: no result within 60 s')
  app.exit(1)
}, 60_000)

main().then(
  () => {
    clearTimeout(watchdog)
    console.log('E2E PASS browser input, native docking, resize, tray resume and cleanup')
    app.exit(0)
  },
  (error: unknown) => {
    clearTimeout(watchdog)
    console.error('E2E FAIL', error)
    app.exit(1)
  },
)
