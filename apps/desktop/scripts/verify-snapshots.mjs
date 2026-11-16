// Run with Electron after the desktop main/preload build. Uses the real Ari
// renderer on ARI_SNAPSHOTS_RENDERER_URL, an isolated profile and a neutral
// external window; no agent prompt is sent.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import koffi from 'koffi'
import { uIOhook, UiohookKey } from 'uiohook-napi'

async function run() {
  if (process.platform !== 'win32' || process.env.ARI_SNAPSHOTS_VERIFY !== '1')
    throw new Error('Run this visible Windows integration check with ARI_SNAPSHOTS_VERIFY=1.')

  const directory = resolve(
    process.env.ARI_SNAPSHOTS_EVIDENCE ?? 'out/snapshots-evidence/integration',
  )
  const profile =
    process.env.ARI_SNAPSHOTS_RESTORE_PROFILE || join(directory, `profile-${Date.now()}`)
  await mkdir(profile, { recursive: true })
  if (!process.env.ARI_SNAPSHOTS_RESTORE_PROFILE)
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({
        version: 1,
        onboarding: { completedAt: Date.now() },
        experimental: { ariaEnabled: true },
        appearance: { mode: 'obsidian' },
        snapshots: { enabled: false, shortcut: 'ctrl+alt+shift+p', animation: true, sound: false },
      }),
    )
  process.env.ARI_DEV_INSTANCE = 'snapshots-overlay-test'
  process.env.ARI_DEV_USER_DATA = profile
  if (process.env.ARI_SNAPSHOTS_RENDERER_URL)
    process.env.ELECTRON_RENDERER_URL = process.env.ARI_SNAPSHOTS_RENDERER_URL
  else delete process.env.ELECTRON_RENDERER_URL

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function until(test, description, timeout = 45000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        const result = await test()
        if (result) return result
      } catch {}
      await delay(50)
    }
    throw new Error(`Timed out: ${description}`)
  }

  await import('../out/main/index.js')
  await app.whenReady()
  let external
  try {
    const main = await until(
      () =>
        BrowserWindow.getAllWindows().find((window) =>
          process.env.ELECTRON_RENDERER_URL
            ? window.webContents.getURL() === process.env.ELECTRON_RENDERER_URL + '/'
            : window.webContents.getURL().endsWith('/renderer/index.html'),
        ),
      'main window',
    )
    await until(
      () =>
        main.webContents.executeJavaScript(
          "typeof window.ari?.invoke === 'function' && document.querySelector('[aria-label=\"Open Aria\"]') !== null && document.querySelector('[data-testid=\"awaken-splash\"]') === null",
        ),
      'ready shell',
    )
    const { sessionId } = await main.webContents.executeJavaScript("window.ari.invoke('aria.open')")
    await main.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="Open Aria"]\').click()',
    )
    await until(
      () =>
        main.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('[data-composer-draft]')).some(element => element.dataset.composerDraft === ${JSON.stringify(sessionId)})`,
        ),
      'Aria composer',
    )
    if (process.env.ARI_SNAPSHOTS_RESTORE_PROFILE) {
      main.show()
      await until(
        () =>
          main.webContents
            .executeJavaScript(`Array.from(document.querySelectorAll('img[alt^="SnapShot "]')).some(image => {
        const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.y >= 0 && rect.y < innerHeight;
      })`),
        'restored visible attachment',
      )
      await main.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      await writeFile(
        join(directory, 'composer-attachment.png'),
        (await main.webContents.capturePage()).toPNG(),
      )
      console.log('SnapShots restore verification passed:', directory)
      app.quit()
      return
    }
    await main.webContents.executeJavaScript(
      "window.ari.invoke('settings.update', { snapshots: { enabled: true, shortcut: 'ctrl+alt+shift+p', animation: true, sound: false } })",
    )
    assert.equal(
      (await main.webContents.executeJavaScript('window.ari.snapshots.status()')).registered,
      true,
    )
    main.hide()
    await main.webContents.executeJavaScript(
      'window.__snapshotEvents = []; window.ari.snapshots.onEvent(event => window.__snapshotEvents.push(event)); void 0',
    )
    let mainShows = 0
    main.on('show', () => {
      mainShows++
    })
    external = new BrowserWindow({
      width: 1000,
      height: 700,
      x: 90,
      y: 80,
      title: 'SnapShots external verification',
      webPreferences: {
        partition: 'snapshots-verification-source',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await external.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:#e9ede8;color:#23332a;font:24px system-ui;padding:64px"><small>SNAPSHOTS / WINDOWS VERIFICATION</small><h1>Keep creating here.</h1><p>The screenshot attaches to Ari without switching apps.</p><input id="editor" value="The caret stays here" style="font:22px system-ui;padding:14px;width:600px"><script>document.getElementById("editor").focus()</script></body></html>',
        ),
    )
    external.show()
    external.focus()
    await external.webContents.executeJavaScript('document.getElementById("editor").focus()')
    const user = koffi.load('user32.dll')
    const foreground = user.func('void* __stdcall GetForegroundWindow()')
    const handle = koffi.decode(external.getNativeWindowHandle(), 'void*')
    const expected = koffi.address(handle)
    // This is fixture setup only. Windows can deny activation to a background
    // launcher, so temporarily join its input queue to activate our own source.
    const setForeground = user.func('bool __stdcall SetForegroundWindow(void* hwnd)')
    const owner = user.func('uint32 __stdcall GetWindowThreadProcessId(void* hwnd, void* process)')
    const attach = user.func(
      'bool __stdcall AttachThreadInput(uint32 first, uint32 second, bool attached)',
    )
    const currentThread = koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()')()
    const foregroundThread = owner(foreground(), null)
    if (foregroundThread && foregroundThread !== currentThread) {
      attach(currentThread, foregroundThread, true)
      try {
        setForeground(handle)
      } finally {
        attach(currentThread, foregroundThread, false)
      }
    } else setForeground(handle)
    await until(() => koffi.address(foreground()) === expected, 'external foreground')
    uIOhook.keyTap(UiohookKey.P, [UiohookKey.Ctrl, UiohookKey.Alt, UiohookKey.Shift])
    const outcome = await until(async () => {
      const events = await main.webContents.executeJavaScript('window.__snapshotEvents')
      const error = events.find((event) => event.type === 'error')
      if (error) return { error: error.message }
      const overlay = BrowserWindow.getAllWindows().find(
        (window) =>
          window !== external &&
          window !== main &&
          window.webContents.getURL().startsWith('data:text/html') &&
          !window.isFocusable(),
      )
      return overlay ? { overlay } : null
    }, 'desktop overlay')
    assert.equal(outcome.error, undefined, outcome.error)
    const overlay = outcome.overlay
    await until(
      () => overlay.webContents.executeJavaScript('document.getAnimations().length > 0'),
      'running overlay animation',
      5000,
    )
    assert.equal(koffi.address(foreground()), expected)
    assert.equal(main.isVisible(), false)
    assert.equal(mainShows, 0)
    // Hold a native overlay frame for repeatable evidence without replaying a capture.
    await overlay.webContents.executeJavaScript(
      'document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 440 })',
    )
    await writeFile(
      join(directory, 'desktop-flight.png'),
      (await overlay.webContents.capturePage()).toPNG(),
    )
    await writeFile(
      join(directory, 'source-window.png'),
      (await external.webContents.capturePage()).toPNG(),
    )
    await overlay.webContents.executeJavaScript(
      'document.getAnimations().forEach(animation => animation.play())',
    )
    await until(
      () =>
        main.webContents.executeJavaScript(
          `JSON.parse(localStorage.getItem('ari.composer-recovery') || '{}').sessions?.[${JSON.stringify(sessionId)}]?.images?.some(image => image.snapshot) === true`,
        ),
      'persisted draft attachment',
    )
    assert.equal(main.isVisible(), false)
    assert.equal(mainShows, 0)
    assert.equal(koffi.address(foreground()), expected)
    await until(() => overlay.isDestroyed(), 'overlay cleanup', 7000)
    assert.equal(
      await external.webContents.executeJavaScript('document.activeElement.id'),
      'editor',
    )
    // Reveal only for the final evidence shot, after asserting capture never did.
    main.show()
    await until(
      () =>
        main.webContents
          .executeJavaScript(`Array.from(document.querySelectorAll('[data-snapshot-id]')).some(image => {
      const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.y < innerHeight;
    })`),
      'visible attachment thumbnail',
    )
    await main.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
    await writeFile(
      join(directory, 'composer-attachment.png'),
      (await main.webContents.capturePage()).toPNG(),
    )
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          captureKeptExternalForeground: true,
          mainShowsDuringCapture: mainShows - 1,
          caretPreserved: true,
          attachmentPersisted: true,
          overlayCleanedUp: true,
        },
        null,
        2,
      ),
    )
    console.log('SnapShots integration passed:', directory)
    external.destroy()
    app.quit()
  } catch (error) {
    console.error(error)
    external?.destroy()
    app.exit(1)
  }
}
void run().catch((error) => {
  console.error(error)
  app.exit(1)
})
