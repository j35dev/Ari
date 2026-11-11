// Run only through the shared heavy runner. Uses the system Chrome and a fresh D: profile.
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { fetch, WebSocket } = globalThis

const stage = process.argv[2]
if (!['before', 'after'].includes(stage)) throw new Error('Expected before or after')
const root = process.cwd()
const { createServer } = await import(pathToFileURL(resolve(root, 'apps/mobile/node_modules/vite/dist/node/index.js')))
const { default: react } = await import(pathToFileURL(resolve(root, 'apps/mobile/node_modules/@vitejs/plugin-react/dist/index.js')))
const fixture = resolve(root, 'apps/mobile/scripts/fixtures/app-state.ts')
const server = await createServer({
  configFile: false, root: resolve(root, 'apps/mobile'), optimizeDeps: { entries: ['scripts/fixtures/index.html'] }, plugins: [
    { name: 'local-review-app-state', enforce: 'pre', resolveId(source, importer) {
      if (importer && importer.replaceAll('\\', '/').includes('/apps/mobile/src/') && /(?:^|\/)app-state$/.test(source)) return fixture
    } }, react(),
  ],
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer.address()
const output = resolve(root, 'docs/screenshots/mobile', stage)
await mkdir(output, { recursive: true })
await mkdir('D:/Projects/.ari-cache/tmp', { recursive: true })
const profile = await mkdtemp('D:/Projects/.ari-cache/tmp/mobile-review-')
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket
const pending = new Map()
let id = 0
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function command(method, params = {}) {
  const commandId = ++id
  const promise = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { pending.delete(commandId); reject(new Error(`CDP timed out: ${method}`)) }, 60_000)
    pending.set(commandId, { resolve: (value) => { clearTimeout(deadline); resolve(value) }, reject: (error) => { clearTimeout(deadline); reject(error) } })
  })
  socket.send(JSON.stringify({ id: commandId, method, params }))
  return promise
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
try {
  let port
  for (let tries = 0; tries < 100; tries++) {
    try { port = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await pause(100) }
  }
  if (!port) throw new Error('Chrome did not start')
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(tabs[0].webSocketDebuggerUrl)
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject })
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') process.stdout.write(`Browser exception ${JSON.stringify(message.params.exceptionDetails)}\n`)
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id)
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result)
    }
  }
  process.stdout.write(`Review server http://127.0.0.1:${address.port}\n`)
  await command('Page.enable')
  await command('Runtime.enable')
  const results = []
  for (const width of [360, 390]) for (const theme of ['light', 'dark']) {
    for (const view of ['home', 'session', 'approval', 'error', 'empty', 'settings', 'files', 'changes', 'pair', 'offline', ...(stage === 'after' ? ['computers', 'computer-add', 'session-short', 'approval-short'] : [])]) {
      const fixtureView = view === 'computers' || view === 'computer-add' ? 'home' : view.replace('-short', '')
      await command('Emulation.setDeviceMetricsOverride', { width, height: view.endsWith('-short') ? 480 : 844, deviceScaleFactor: 1, mobile: true })
      await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
      process.stdout.write(`Opening ${width}-${theme}-${view}\n`)
      await evaluate(`location.href = ${JSON.stringify(`http://127.0.0.1:${address.port}/scripts/fixtures/index.html?theme=${theme}&view=${fixtureView}`)}`)
      let ready = false
      for (let tries = 0; tries < 450; tries++) {
        ready = await evaluate('document.querySelector("#root")?.textContent.length > 0')
        if (ready) break
        await pause(100)
      }
      if (!ready) throw new Error(`Fixture failed to render ${view}`)
      await evaluate('document.fonts.ready.then(() => true)')
      await pause(250)
      if (view === 'files') {
        await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.getAttribute("aria-label") === "More")?.click()')
        await pause(100)
        await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Files")?.click()')
      }
      if (view === 'changes') await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.getAttribute("aria-label") === "Changes" || b.textContent.trim() === "Changes")?.click()')
      if (view === 'computers' || view === 'computer-add') {
        await evaluate('document.querySelector("button[aria-label^=\"Switch computer:\"]")?.click()')
        await pause(100)
        if (view === 'computer-add') await evaluate('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Add computer")?.click()')
      }
      await pause(250)
      const geometry = await evaluate('({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, text: document.querySelector("#root").textContent})')
      if (!geometry.text) throw new Error(`Fixture became empty in ${view}`)
      if (geometry.scrollWidth > width) throw new Error(`Page overflow in ${view} at ${width}`)
      const screenshot = await command('Page.captureScreenshot', { format: 'png' })
      const filename = `${width}-${theme}-${view}.png`
      await writeFile(resolve(output, filename), Buffer.from(screenshot.data, 'base64'))
      results.push({ filename, width, theme, view, scrollWidth: geometry.scrollWidth })
      process.stdout.write(`Captured ${stage}/${filename}\n`)
    }
  }
  await writeFile(resolve(output, 'evidence.json'), JSON.stringify({ stage, profile, source: 'local read-only component fixtures', results }, null, 2))
} finally {
  socket?.close()
  chrome.kill()
  // Chrome's browser process can survive kill on Windows; close this isolated profile explicitly.
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(chrome.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  await server.close()
}
