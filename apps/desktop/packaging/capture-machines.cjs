// Run with the coordinator runner and `pnpm --filter @ari/desktop exec electron
// packaging/capture-machines.cjs` after building machines-fixture.config.ts.
// This starts only a hidden Chromium fixture, with an isolated temporary profile.
const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const { mkdirSync, mkdtempSync } = require('node:fs')
const { resolve, join } = require('node:path')

const scratch = resolve('out/machines-capture-profiles')
mkdirSync(scratch, { recursive: true })
app.setPath('userData', mkdtempSync(join(scratch, 'profile-')))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('lang', 'en-US')

const evidence = resolve('../../docs/research/evidence/desktop-machines')
const errors = []
let window
const watchdog = setTimeout(() => app.exit(1), 60_000)

async function ready(view) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = await window.webContents.executeJavaScript(`
      document.body.innerText.includes(${JSON.stringify(view === 'settings'
        ? 'K7MV-4AX9' : 'The test runner now checks commit headroom')})
    `)
    if (found) {
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Fixture did not finish loading: ${view}`)
}

app.whenReady().then(async () => {
  await mkdir(evidence, { recursive: true })
  window = new BrowserWindow({
    width: 1440, height: 1100, show: false, useContentSize: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false, partition: 'machines-capture',
    },
  })
  // No real host or other external endpoint can be contacted by this fixture.
  window.webContents.session.webRequest.onBeforeRequest((request, done) => {
    done({ cancel: !['file:', 'data:', 'blob:'].some((prefix) => request.url.startsWith(prefix)) })
  })
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') errors.push(details.message)
  })
  const captures = []
  for (const theme of ['light', 'dark']) {
    for (const view of ['settings', 'workspace']) {
      await window.loadFile(resolve('out/machines-fixture/testing/machines.html'), { query: { theme, view } })
      await ready(view)
      const state = await window.webContents.executeJavaScript(`({
        ...window.__ari.state(),
        activeTheme: document.documentElement.dataset.ariTheme,
        title: document.querySelector('h1')?.textContent,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        text: document.body.innerText,
        sidebar: (() => {
          const r = document.querySelector('aside')?.getBoundingClientRect();
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        })()
      })`)
      if (state.activeTheme !== (theme === 'light' ? 'porcelain' : 'obsidian'))
        throw new Error(`Wrong theme: ${state.activeTheme}`)
      if (state.alerts.length || state.horizontalOverflow)
        throw new Error('Fixture has an alert or horizontal overflow')
      if (state.trace.some((method) => !method.startsWith('machines.') &&
        !['settings.get', 'stream.subscribe', 'stream.unsubscribe'].includes(method)))
        throw new Error('Fixture reached a non-fixture RPC')
      const filename = `machines-${view}-${theme}.png`
      await writeFile(join(evidence, filename), (await window.webContents.capturePage()).toPNG())
      if (view === 'workspace') {
        const rect = Object.fromEntries(Object.entries(state.sidebar).map(([key, value]) => [key, Math.round(value)]))
        await writeFile(join(evidence, `machines-sidebar-${theme}.png`),
          (await window.webContents.capturePage(rect)).toPNG())
      }
      captures.push({ filename, ...state })
    }
  }
  if (errors.length) throw new Error(`Renderer console errors: ${errors.join('; ')}`)
  await writeFile(join(evidence, 'capture.json'), JSON.stringify({
    fixture: 'real renderer components with fake RPC only',
    browser: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    profile: 'temporary D worktree profile, nonpersistent browser partition',
    dimensions: { width: 1440, height: 1100, scale: 1 },
    captures, errors,
  }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ evidence, screenshots: 6, success: true }) + '\n')
  clearTimeout(watchdog)
  window.destroy()
  app.quit()
}).catch((error) => {
  process.stderr.write(String(error.stack ?? error) + '\n')
  clearTimeout(watchdog)
  app.exit(1)
})
