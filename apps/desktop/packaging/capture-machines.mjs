// Build machines-fixture.config.ts and run through run-heavy.mjs. This opens a
// hidden Chromium window with a temporary D: profile and refuses network access.
/* global process, setTimeout, clearTimeout */
import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'

const scratch = resolve('out/machines-capture-profiles')
mkdirSync(scratch, { recursive: true })
app.setPath('userData', mkdtempSync(join(scratch, 'profile-')))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const evidence = resolve('../../docs/research/evidence/desktop-machines-parity')
const errors = []
const watchdog = setTimeout(() => app.exit(1), 60_000)
let window
let activeCapture = 'startup'
async function ready(view) {
  const expected = view === 'settings' || view === 'permissions' ? 'K7MV-4AX9' :
    view === 'draft' || view === 'auto' || view === 'picker' ? 'Execution machine' : 'The test runner now checks commit headroom'
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(expected)}) ||
      !!document.querySelector('[aria-label="${expected}"]')`)
    if (found) {
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
      await new Promise((done) => setTimeout(done, 800))
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Fixture did not load: ${view}`)
}
async function frame() {
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('No Chromium paint')), 5000)
    window.webContents.once('paint', (_event, _dirty, bitmap) => { clearTimeout(timeout); done(bitmap) })
    window.webContents.invalidate()
  })
}
app.whenReady().then(async () => {
  await mkdir(evidence, { recursive: true })
  window = new BrowserWindow({ width: 1440, height: 1100, show: false, useContentSize: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      partition: 'machines-parity-capture', offscreen: true } })
  window.webContents.session.webRequest.onBeforeRequest((request, done) =>
    done({ cancel: !['file:', 'data:', 'blob:'].some((prefix) => request.url.startsWith(prefix)) }))
  window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message) })
  const captures = []
  for (const theme of ['light', 'dark']) for (const view of ['settings', 'permissions', 'workspace', 'receipt', 'draft', 'auto', 'picker']) {
    activeCapture = `${view}-${theme}`
    await window.loadFile(resolve('out/machines-fixture/testing/machines.html'), { query: { theme, view } })
    await ready(view)
    if (view === 'picker') await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Execution machine"]').click()`)
    if (view === 'permissions') await window.webContents.executeJavaScript(`
      (() => { const card = document.querySelector('article[aria-label="Studio workstation"]');
        [...card.querySelectorAll('[role="tab"]')].find(button => button.textContent.trim() === 'Your permissions').click();
        card.scrollIntoView({ block: 'start' }); })()`)
    if (view === 'receipt') await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Check status').click()`)
    // Paint the selected tab/receipt state before registering the capture listener.
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await new Promise((done) => setTimeout(done, 150))
    const state = await window.webContents.executeJavaScript(`({ ...window.__ari.state(),
      activeTheme: document.documentElement.dataset.ariTheme,
      text: document.body.innerText,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      selector: !!document.querySelector('[aria-label="Execution machine"]'),
      pickerOpen: (() => { const menu = document.querySelector('[role="menu"][aria-label="Execution machines"]');
        const rect = menu?.getBoundingClientRect(); return !!(rect?.width && rect?.height && getComputedStyle(menu).visibility !== 'hidden' &&
          document.querySelector('[aria-label="Execution machine"]')?.getAttribute('aria-expanded') === 'true'); })(),
      sidebar: (() => { const r = document.querySelector('[aria-label="Projects and sessions"]')?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })()
    })`)
    if (state.horizontalOverflow || state.activeTheme !== (theme === 'light' ? 'porcelain' : 'obsidian'))
      throw new Error('Wrong theme or horizontal overflow')
    if (state.selector !== (view === 'draft' || view === 'auto' || view === 'picker')) throw new Error('Machine selector is outside a project draft')
    if (view === 'picker' && !state.pickerOpen) throw new Error('Execution machine picker is closed')
    if (view === 'workspace' && (state.text.includes('Could not load this turn') || !state.text.includes('Studio workstation')))
      throw new Error('Normal host session fixture is unhealthy')
    if (state.trace.includes('machines.command')) throw new Error('A screenshot dispatched a mutation')
    const filename = `machines-${view}-${theme}.png`
    const bitmap = await frame()
    await writeFile(join(evidence, filename), bitmap.toPNG())
    if (view === 'workspace') {
      const rect = Object.fromEntries(Object.entries(state.sidebar).map(([key, value]) => [key, Math.round(value)]))
      await writeFile(join(evidence, `machines-sidebar-${theme}.png`), bitmap.crop(rect).toPNG())
    }
    captures.push({ filename, ...state, imageSize: bitmap.getSize() })
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`)
  await writeFile(join(evidence, 'capture.json'), JSON.stringify({
    fixture: 'normal integrated renderer components; fake RPC; component evidence only',
    browser: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    profile: 'temporary D worktree profile', captures, errors,
  }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ evidence, screenshots: 16, success: true }) + '\n')
  clearTimeout(watchdog); window.destroy(); app.quit()
}).catch((error) => { process.stderr.write(`Capture ${activeCapture}: ${String(error)}${errors.length ? `; ${errors.join('; ')}` : ''}\n`); app.exit(1) })
