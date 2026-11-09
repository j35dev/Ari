import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { WidgetSnapshot } from './model'
import type { Settings } from '@ari/contracts/settings'
import { AriaWidget } from './index'
import { withInjectedKeys } from './injected-keys'

// Build the renderer first, then bundle this entry to out/e2e with Vite and
// run with Electron. The fixture uses the production renderer and preload.
async function capture(): Promise<void> {
  const main = new BrowserWindow({ show: false })
  const directory = process.env['ARIA_WIDGET_SHOTS'] ?? 'D:\\tmp\\aria-widget-shots'
  await mkdir(directory, { recursive: true })
  let state: WidgetSnapshot = {
    id: 0,
    phase: 'hidden',
    text: '',
    setup: false,
    theme: 'obsidian',
    reducedMotion: true,
  }
  ipcMain.handle('ari:ariaWidget.ready', () => state)
  ipcMain.handle('ari:ariaWidget.speech', () => ({ ready: false }))
  ipcMain.handle('ari:ariaWidget.error', () => undefined)
  ipcMain.handle('ari:ariaWidget.complete', () => undefined)
  ipcMain.handle('ari:ariaWidget.settings', () => undefined)
  const win = new BrowserWindow({
    width: 380,
    height: 72,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/widget.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  await win.loadFile(join(import.meta.dirname, '../renderer/widget/index.html'))
  await win.webContents.executeJavaScript('document.fonts.ready')
  const samples: readonly (Pick<WidgetSnapshot, 'phase' | 'text' | 'setup'> & { name: string })[] =
    [
      { name: 'listening', phase: 'listening', text: '', setup: false },
      { name: 'transcribing', phase: 'transcribing', text: '', setup: false },
      {
        name: 'sent',
        phase: 'sent',
        text: 'Fix the sign-in flow and check the tests',
        setup: false,
      },
      { name: 'error', phase: 'error', text: 'No speech heard', setup: false },
      { name: 'setup', phase: 'error', text: 'Set up speech to text in Settings', setup: true },
    ]
  for (const theme of ['obsidian', 'porcelain']) {
    for (const sample of samples) {
      state = { ...state, ...sample, id: state.id + 1, theme }
      win.webContents.send('ari:ariaWidget.state', state)
      await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const frame = () => document.querySelector('.aria-pill')?.dataset.phase === ${JSON.stringify(sample.phase)}
          && document.documentElement.dataset.ariTheme === ${JSON.stringify(theme)}
          ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : requestAnimationFrame(frame);
        frame();
      })`)
      const image = await win.webContents.capturePage()
      const filename = `${theme}-${sample.name}.png`
      await writeFile(join(directory, filename), image.toPNG())
      console.log(`Captured ${filename}`)
    }
  }

  // Verify the shipped Node-API addon with this Electron runtime, including
  // real Windows key release events. F24 has no normal desktop shortcut.
  const events: string[] = []
  const down = (event: { keycode: number }): void => {
    if (event.keycode === UiohookKey.F24) events.push('down')
  }
  const up = (event: { keycode: number }): void => {
    if (event.keycode === UiohookKey.F24) events.push('up')
  }
  uIOhook.on('keydown', down)
  uIOhook.on('keyup', up)
  uIOhook.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await withInjectedKeys(uIOhook, [UiohookKey.F24], async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(events, ['down', 'up'])
    assert.equal(win.isFocusable(), false)
    console.log(
      `Native hook down/up passed on Electron ${process.versions.electron}, Node-API ${process.versions.napi}`,
    )
  } finally {
    uIOhook.stop()
    uIOhook.removeListener('keydown', down)
    uIOhook.removeListener('keyup', up)
    win.destroy()
  }

  for (const method of ['ready', 'speech', 'error', 'complete', 'settings'])
    ipcMain.removeHandler(`ari:ariaWidget.${method}`)
  const focus = BrowserWindow.getFocusedWindow()
  const widget = new AriaWidget({
    invoke: () => Promise.resolve({ ready: true }),
    openSettings: () => undefined,
  })
  try {
    await widget.configure({
      appearance: { mode: 'obsidian', themeId: 'obsidian', reducedMotion: true },
      speech: { enabled: true, shortcut: 'ctrl+f24' },
    } as unknown as Settings)
    const pill = BrowserWindow.getAllWindows().find((candidate) => candidate !== main)
    assert.ok(pill, 'configured hook warms the widget renderer')
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Generic SendInput modifiers exercise keycode tracking without mask bits.
    await withInjectedKeys(uIOhook, [UiohookKey.Ctrl, UiohookKey.F24], async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await pill.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Listening did not appear')), 5000);
      const frame = () => document.querySelector('.aria-pill')?.dataset.phase === 'listening'
        ? (clearTimeout(timeout), resolve()) : requestAnimationFrame(frame);
      frame();
    })`)
      assert.equal(main.isVisible(), false)
      assert.equal(pill.isVisible(), true)
      assert.equal(pill.isFocused(), false)
      assert.equal(BrowserWindow.getFocusedWindow(), focus)
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(pill.isVisible(), false, 'silent release quietly hides the widget')
    console.log('Native injected chord passed without activating the widget or main window')
    pill.webContents.forcefullyCrashRenderer()
    const recovered = await new Promise<BrowserWindow>((resolve, reject) => {
      const deadline = performance.now() + 10_000
      const poll = (): void => {
        const next = BrowserWindow.getAllWindows().find(
          (candidate) => candidate !== main && candidate !== pill,
        )
        if (next) resolve(next)
        else if (performance.now() >= deadline)
          reject(new Error('Widget did not recover after renderer crash'))
        else setTimeout(poll, 50)
      }
      poll()
    })
    await recovered.webContents.executeJavaScript("window.ariaWidget.invoke('ariaWidget.ready')")
    await new Promise((resolve) => setTimeout(resolve, 250))
    await withInjectedKeys(uIOhook, [UiohookKey.Ctrl, UiohookKey.F24], async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(recovered.isVisible(), true)
      assert.equal(recovered.isFocused(), false)
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(recovered.isVisible(), false)
    console.log('Renderer crash recovery re-armed the widget successfully')
  } finally {
    widget.close()
    main.destroy()
  }
}

void app
  .whenReady()
  .then(capture)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error)
      app.exit(1)
    },
  )
