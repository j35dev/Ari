// Run with the coordinator runner and `pnpm --filter @ari/desktop exec electron
// packaging/capture-machines.mjs` after building machines-fixture.config.ts.
// This starts only a hidden Chromium fixture, with an isolated temporary profile.
// Add --composer-only to refresh workspace/receipt images and preserve approved
// settings/sidebar captures and their metadata.
/* global process, setTimeout, clearTimeout */
import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'

const scratch = resolve('out/machines-capture-profiles')
mkdirSync(scratch, { recursive: true })
app.setPath('userData', mkdtempSync(join(scratch, 'profile-')))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('lang', 'en-US')

const evidence = resolve('../../docs/research/evidence/desktop-machines')
const composerOnly = process.argv.includes('--composer-only')
const errors = []
let window
const watchdog = setTimeout(() => app.exit(1), 60_000)

async function ready(view) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = await window.webContents.executeJavaScript(`
      document.body.innerText.includes(${JSON.stringify(
        view === 'settings' ? 'K7MV-4AX9' : 'The test runner now checks commit headroom',
      )})
    `)
    if (found) {
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
      await window.webContents.executeJavaScript(
        'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))',
      )
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Fixture did not finish loading: ${view}`)
}

async function paintedFrame() {
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('No Chromium paint arrived')), 5000)
    window.webContents.once('paint', (_event, _dirty, bitmap) => {
      clearTimeout(timeout)
      done(bitmap)
    })
    window.webContents.invalidate()
  })
}

app
  .whenReady()
  .then(async () => {
    await mkdir(evidence, { recursive: true })
    window = new BrowserWindow({
      width: 1440,
      height: 1100,
      show: false,
      useContentSize: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: 'machines-capture',
        offscreen: true,
      },
    })
    // No real host or other external endpoint can be contacted by this fixture.
    window.webContents.session.webRequest.onBeforeRequest((request, done) => {
      done({
        cancel: !['file:', 'data:', 'blob:'].some((prefix) => request.url.startsWith(prefix)),
      })
    })
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message)
    })
    const captures = []
    const previous = composerOnly
      ? JSON.parse(await readFile(join(evidence, 'capture.json'), 'utf8'))
      : null
    for (const theme of ['light', 'dark']) {
      for (const view of composerOnly
        ? ['workspace', 'receipt']
        : ['settings', 'workspace', 'receipt']) {
        await window.loadFile(resolve('out/machines-fixture/testing/machines.html'), {
          query: { theme, view },
        })
        await ready(view)
        if (view === 'receipt') {
          await window.webContents.executeJavaScript(`
            [...document.querySelectorAll('[aria-label="Unconfirmed remote action"] button')]
              .find(button => button.textContent.trim() === 'Check receipt').click()
          `)
          const deadline = Date.now() + 10_000
          while (
            !(await window.webContents.executeJavaScript(
              'document.body.innerText.includes("Its outcome is unknown")',
            ))
          ) {
            if (Date.now() > deadline) throw new Error('Missing old-host outcome warning')
            await new Promise((done) => setTimeout(done, 100))
          }
        }
        const state = await window.webContents.executeJavaScript(`({
        ...window.__ari.state(),
        activeTheme: document.documentElement.dataset.ariTheme,
        title: document.querySelector('h1')?.textContent,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
        buttons: [...document.querySelectorAll('button')].map(e => e.textContent.trim()),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        text: document.body.innerText,
        attachmentPicker: (() => {
          const input = document.querySelector('input[type="file"]');
          const button = [...document.querySelectorAll('button')]
            .find(button => button.textContent.trim() === 'Attach image');
          return input && button ? {
            label: input.getAttribute('aria-label'),
            hidden: getComputedStyle(input).display === 'none',
            inputDisabled: input.disabled,
            buttonDisabled: button.disabled,
            iconHidden: button.querySelector('svg')?.getAttribute('aria-hidden') === 'true'
          } : null;
        })(),
        sidebar: (() => {
          const r = document.querySelector('[aria-label="Remote computers"]')?.getBoundingClientRect();
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
        })()
      })`)
        if (
          view !== 'settings' &&
          (!state.attachmentPicker?.hidden ||
            state.attachmentPicker.label !== 'Attach image to host session' ||
            !state.attachmentPicker.iconHidden ||
            state.attachmentPicker.inputDisabled !== (view === 'receipt') ||
            state.attachmentPicker.buttonDisabled !== (view === 'receipt'))
        )
          throw new Error(
            'The attachment control is visible natively or has incorrect accessibility/availability',
          )
        if (state.activeTheme !== (theme === 'light' ? 'porcelain' : 'obsidian'))
          throw new Error(`Wrong theme: ${state.activeTheme}`)
        if (
          (view === 'receipt'
            ? state.alerts.length !== 1 || !state.alerts[0].includes('Its outcome is unknown')
            : state.alerts.length > 0) ||
          state.horizontalOverflow
        )
          throw new Error('Fixture has an alert or horizontal overflow')
        if (
          state.trace.includes('machines.command') ||
          state.buttons.some((button) => /retry/i.test(button))
        )
          throw new Error('A saved action was resent or a retry control is visible')
        if (
          state.trace.some(
            (method) =>
              !method.startsWith('machines.') &&
              !['settings.get', 'stream.subscribe', 'stream.unsubscribe'].includes(method),
          )
        )
          throw new Error('Fixture reached a non-fixture RPC')
        const filename = `machines-${view}-${theme}.png`
        await window.webContents.executeJavaScript(
          'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))',
        )
        const bitmap = await paintedFrame()
        await writeFile(join(evidence, filename), bitmap.toPNG())
        if (view === 'workspace' && !composerOnly) {
          const rect = Object.fromEntries(
            Object.entries(state.sidebar).map(([key, value]) => [key, Math.round(value)]),
          )
          await writeFile(
            join(evidence, `machines-sidebar-${theme}.png`),
            bitmap.crop(rect).toPNG(),
          )
        }
        captures.push({ filename, ...state, imageSize: bitmap.getSize() })
        if (view === 'settings') {
          await window.webContents.executeJavaScript(`
            const panel = document.querySelector('.ari-enter-rise.ari-scroll');
            panel.scrollTop = panel.scrollHeight;
            new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
          `)
          const bottom = await paintedFrame()
          const bottomName = `machines-settings-bottom-${theme}.png`
          await writeFile(join(evidence, bottomName), bottom.toPNG())
          captures.push({
            filename: bottomName,
            view: 'settings-bottom',
            theme,
            imageSize: bottom.getSize(),
          })
        }
      }
    }
    if (errors.length) throw new Error(`Renderer console errors: ${errors.join('; ')}`)
    await writeFile(
      join(evidence, 'capture.json'),
      JSON.stringify(
        {
          fixture: 'real renderer components with fake RPC only',
          browser: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
          profile: 'temporary D worktree profile, nonpersistent browser partition',
          dimensions: { requestedWidth: 1440, requestedHeight: 1100, scale: 1 },
          captures: previous
            ? previous.captures.map(
                (capture) =>
                  captures.find((fresh) => fresh.filename === capture.filename) ?? capture,
              )
            : captures,
          errors,
        },
        null,
        2,
      ) + '\n',
    )
    process.stdout.write(
      JSON.stringify({ evidence, screenshots: composerOnly ? 4 : 10, success: true }) + '\n',
    )
    clearTimeout(watchdog)
    window.destroy()
    app.quit()
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + '\n')
    clearTimeout(watchdog)
    app.exit(1)
  })
