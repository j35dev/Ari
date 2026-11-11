// Isolated Settings component capture. Run only through the Machines heavy-work runner.
// No Electron, real desktop RPC, saved settings, device keys or Tailscale commands are used.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clearTimeout, setTimeout } from 'node:timers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (!root.startsWith('D:\\') && !root.startsWith('D:/')) throw new Error('Capture must run on D:')
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(requireDesktop.resolve('vite')).href)
const { default: react } = await import(
  pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href
)
const scratchParent = join(root, 'fixtures/tmp')
await mkdir(scratchParent, { recursive: true })
const scratch = await mkdtemp(join(scratchParent, 'mobile-access-'))
const output = join(root, 'docs/screenshots/mobile-access')
await mkdir(output, { recursive: true })
const fsUrl = (path) => relative(scratch, path).replaceAll('\\', '/')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let server
let browser
let socket

try {
  await writeFile(
    join(scratch, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Ari Mobile access review fixture</title></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
  )
  await writeFile(
    join(scratch, 'fixture.tsx'),
    `
import React from 'react'
import { createRoot } from 'react-dom/client'
import '${fsUrl(join(root, 'packages/ui/src/fonts.ts'))}'
import '${fsUrl(join(root, 'apps/desktop/src/renderer/src/styles/index.css'))}'
import { RemoteSettings } from '${fsUrl(join(root, 'apps/desktop/src/renderer/src/features/settings/RemoteSettings.tsx'))}'
const scenario = new URLSearchParams(location.search).get('state') ?? 'ready'
const theme = new URLSearchParams(location.search).get('theme') ?? 'obsidian'
document.documentElement.dataset.ariTheme = theme
document.documentElement.dataset.ariScheme = theme === 'porcelain' ? 'light' : 'dark'
const origin = 'https://workstation.tailnet.ts.net:8443'
const remote = { enabled: true, origin: 'http://127.0.0.1:8787', clientUrl: scenario === 'repair' ? null : origin, allowedOrigins: [], invitation: null, pending: scenario === 'approval' ? { invitationId: 'review_invitation', displayName: 'MacBook Air', confirmationCode: '7F3K-2Q9D', expiresAt: Date.now() + 120000 } : null, devices: [{ deviceId: 'review_phone', displayName: 'iPhone 16', allProjects: true, projectIds: ['ari'], pairedAt: 1794384000000, lastSeenAt: 1794384600000, allowTerminal: false }], error: null }
const tailscale = { installed: true, dnsName: 'workstation.tailnet.ts.net', origin, httpsPort: 8443, serving: scenario !== 'repair', owned: true, target: 'http://127.0.0.1:8787', targetListening: scenario !== 'repair', conflicts: scenario === 'repair' ? [{ origin, httpsPort: 8443, mountPath: '/docs', target: '/shared/docs', kind: 'path', listening: null }] : [], suggestedHttpsPort: 8444, error: scenario === 'repair' ? 'Ari’s saved address needs repair. The gateway changed; other services are still available.' : null }
const connect = { phase: 'unconfigured', origin: null, computerName: null, computerId: null, clientUrl: null, error: null, browserUrl: null, expiresAt: null, cloudflaredAvailable: false }
window.ari = { invoke: async (method) => { if (method === 'remote.status') return remote; if (method === 'remote.tailscale.status') return tailscale; if (method === 'remote.connect.status') return connect; if (method.startsWith('stream.')) return {}; throw new Error('Fixture refuses mutation: ' + method) }, subscribe: () => () => {} }
const style = document.createElement('style')
style.textContent = 'body,#root{height:auto;min-height:100vh;overflow:visible}'
document.head.appendChild(style)
createRoot(document.getElementById('root')).render(<RemoteSettings />)
window.__captureLoaded = true
`,
  )
  await build({
    configFile: false,
    root: scratch,
    plugins: [react()],
    resolve: {
      alias: {
        react: dirname(requireDesktop.resolve('react')),
        'react-dom': dirname(requireDesktop.resolve('react-dom')),
      },
      dedupe: ['react', 'react-dom'],
    },
    css: { postcss: join(root, 'apps/desktop') },
    cacheDir: join(scratch, 'node_modules/.vite'),
    build: { outDir: join(scratch, 'dist'), emptyOutDir: true },
  })
  const distribution = resolve(scratch, 'dist')
  server = createServer((request, response) => {
    const url = new globalThis.URL(request.url, 'http://127.0.0.1')
    const file = resolve(
      distribution,
      url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`,
    )
    const path = relative(distribution, file)
    if (path.startsWith('..') || resolve(distribution, path) !== file) {
      response.writeHead(403).end()
      return
    }
    void readFile(file)
      .then((bytes) => {
        const mime = file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.woff2')
              ? 'font/woff2'
              : 'text/html'
        response.writeHead(200, { 'content-type': mime }).end(bytes)
      })
      .catch(() => response.writeHead(404).end())
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const preflight = await globalThis.fetch(`${origin}/`, {
    signal: globalThis.AbortSignal.timeout(20000),
  })
  if (!preflight.ok) throw new Error(`Fixture server returned ${preflight.status}`)
  process.stdout.write(JSON.stringify({ fixtureServer: origin, status: preflight.status }) + '\n')
  const profile = join(scratch, 'chrome-profile')
  browser = spawn(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
      break
    } catch {
      await delay(100)
    }
  }
  if (!port) throw new Error('Temporary Chrome profile did not start')
  const targets = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((entry) => entry.type === 'page')
  if (!target) throw new Error('No fixture browser target')
  socket = new globalThis.WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      clearTimeout(request.timeout)
      message.error
        ? request.reject(new Error(JSON.stringify(message.error)))
        : request.done(message.result)
    }
  })
  socket.addEventListener('close', () => process.stdout.write('Fixture CDP connection closed\n'))
  const send = (method, params = {}) =>
    new Promise((done, reject) => {
      const nextId = ++id
      const timeout = setTimeout(() => {
        pending.delete(nextId)
        reject(new Error(`CDP timeout: ${method}`))
      }, 20000)
      pending.set(nextId, { done, reject, timeout })
      socket.send(JSON.stringify({ id: nextId, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1080,
    height: 1600,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const captures = []
  for (const theme of ['obsidian', 'porcelain']) {
    for (const scenario of ['ready', 'repair', 'approval']) {
      const beforeErrors = errors.length
      process.stdout.write(JSON.stringify({ navigating: scenario, theme }) + '\n')
      await send('Page.navigate', { url: `${origin}/?state=${scenario}&theme=${theme}` })
      let loaded = false
      for (let attempt = 0; attempt < 150; attempt++) {
        const result = await send('Runtime.evaluate', {
          expression:
            "window.__captureLoaded === true && document.querySelector('[role=\"switch\"]')?.getAttribute('aria-checked') === 'true'",
          returnByValue: true,
        })
        if (result.result.value === true) {
          loaded = true
          break
        }
        await delay(100)
      }
      if (!loaded) throw new Error(`Settings fixture did not load: ${JSON.stringify(errors)}`)
      await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true })
      await delay(500)
      if (errors.length !== beforeErrors)
        throw new Error(`Renderer exceptions: ${JSON.stringify(errors)}`)
      const { cssContentSize } = await send('Page.getLayoutMetrics')
      const { data } = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 },
      })
      const name = `settings-${scenario}-${theme}.png`
      await writeFile(join(output, name), Buffer.from(data, 'base64'))
      captures.push({ name, width: cssContentSize.width, height: cssContentSize.height })
    }
  }
  await writeFile(
    join(output, 'capture.json'),
    JSON.stringify(
      {
        surface:
          'Isolated actual RemoteSettings renderer with Ari fonts and tokens; temporary browser profile; read-only synthetic RPC',
        captures,
      },
      null,
      2,
    ) + '\n',
  )
  process.stdout.write(JSON.stringify({ screenshots: captures }) + '\n')
  await send('Browser.close')
} finally {
  socket?.close()
  if (browser && browser.exitCode === null) {
    browser.kill()
    await new Promise((done) => {
      browser.once('exit', done)
      setTimeout(done, 5000)
    })
  }
  if (server)
    await new Promise((done) => {
      server.closeAllConnections()
      server.close(done)
    })
  const ownedRelative = relative(scratchParent, scratch)
  if (!ownedRelative.startsWith('mobile-access-') || ownedRelative.includes('..'))
    throw new Error('Refusing cleanup outside owned fixture')
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
}
