// Records the stream replay in headless Chrome: timed screenshots plus a
// per-frame trace of how much text appeared and how far the view jumped.
//
//   node capture.mjs <outDir> [delivery=tokens] [theme=obsidian] [port=5331] [everyMs=400]
//
// Needs the fixture server: vite --config streaming-fixture.config.ts --port 5331
/* global process, setTimeout, fetch, WebSocket, Buffer, console */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const [outDir, delivery = 'tokens', theme = 'obsidian', port = '5331', everyMs = '400'] =
  process.argv.slice(2)
if (!outDir) throw new Error('usage: capture.mjs <outDir> [delivery] [theme] [port] [everyMs]')
mkdirSync(outDir, { recursive: true })

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const debugPort = 9400 + Math.floor(Math.random() * 80)
const profile = join(tmpdir(), `ari-replay-${debugPort}`)
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--window-size=1100,860',
  '--hide-scrollbars',
  'about:blank',
])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let targets
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
    if (targets.some((t) => t.type === 'page')) break
  } catch {
    // Chrome is still starting.
  }
  await sleep(200)
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method) events.push(msg)
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1100,
  height: 860,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', {
  url: `http://127.0.0.1:${port}/testing/stream-replay.html?delivery=${delivery}&theme=${theme}&at=0`,
})
for (let i = 0; i < 100; i++) {
  if (await evaluate('Boolean(window.__replay)')) break
  await sleep(100)
}
await sleep(600)

// Per-frame trace: visible prose length, scroll position, and where the last
// line of prose sits, so jumps and bursts can be counted afterwards.
await evaluate(`(() => {
  const trace = []
  window.__trace = trace
  const scroller = document.querySelector('.ari-transcript-scroll')
  const tick = (now) => {
    const prose = [...document.querySelectorAll('.ari-md')].map((n) => n.textContent.length).reduce((a, b) => a + b, 0)
    const rows = document.querySelectorAll('.ari-chat-column > div').length
    trace.push({ t: Math.round(now), prose, top: scroller.scrollTop, height: scroller.scrollHeight, rows })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`)

const t0 = Date.now()
await evaluate('window.__replay.start()')
let shot = 0
while (true) {
  const elapsed = Date.now() - t0
  const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result
  writeFileSync(join(outDir, `f${String(shot).padStart(3, '0')}-${elapsed}.png`), Buffer.from(data, 'base64'))
  shot++
  const state = await evaluate('window.__replay.state()')
  if (!state.running && elapsed > 1000) break
  const wait = shot * Number(everyMs) - (Date.now() - t0)
  if (wait > 0) await sleep(wait)
}
await sleep(1200)
const { data } = (await send('Page.captureScreenshot', { format: 'png' })).result
writeFileSync(join(outDir, `final.png`), Buffer.from(data, 'base64'))

const trace = await evaluate('window.__trace')
writeFileSync(join(outDir, 'trace.json'), JSON.stringify(trace))

// Summary: how bursty the prose growth was and how often the view jumped.
let growFrames = 0
let bigJumps = 0
let maxGrow = 0
let maxScroll = 0
const grows = []
for (let i = 1; i < trace.length; i++) {
  const grow = trace[i].prose - trace[i - 1].prose
  const scroll = trace[i].top - trace[i - 1].top
  if (grow > 0) {
    growFrames++
    grows.push(grow)
  }
  if (grow > maxGrow) maxGrow = grow
  if (Math.abs(scroll) > maxScroll) maxScroll = Math.abs(scroll)
  if (Math.abs(scroll) > 60) bigJumps++
}
grows.sort((a, b) => a - b)
const summary = {
  delivery,
  frames: trace.length,
  growFrames,
  medianGrowChars: grows[Math.floor(grows.length / 2)] ?? 0,
  p95GrowChars: grows[Math.floor(grows.length * 0.95)] ?? 0,
  maxGrowChars: maxGrow,
  scrollJumpsOver60px: bigJumps,
  maxScrollJumpPx: maxScroll,
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
ws.close()
chrome.kill()
await sleep(500)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  // The profile is still locked; the OS temp cleanup takes it.
}
