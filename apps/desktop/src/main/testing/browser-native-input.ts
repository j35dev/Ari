import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer } from 'electron'
import type { BrowserWindow, NativeImage, WebContentsView } from 'electron'

async function until(test: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await test())) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

/** Exercise Chromium's native input path on the docked view, without DOM event dispatch. */
export async function checkNativeBrowserInput(
  win: BrowserWindow,
  page: WebContentsView,
): Promise<void> {
  // Exercise the displayed native surface even when the test launcher starts
  // behind another app. Occluded windows can omit embedded views in captures.
  if (process.platform === 'win32' && process.env.ARI_BROWSER_NATIVE_CAPTURE === '1') {
    win.hide()
    win.setAlwaysOnTop(true)
  }
  win.show()
  win.focus()
  const wc = page.webContents
  assert.equal(wc.isOffscreen(), false)
  const field = (await wc.executeJavaScript(`(() => {
    const field = document.querySelector('#field'); field.value = '';
    const rect = field.getBoundingClientRect(); return { x: Math.round(rect.x + 20), y: Math.round(rect.y + 10) };
  })()`)) as { x: number; y: number }
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', ...field })
  wc.sendInputEvent({ type: 'mouseDown', ...field, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', ...field, button: 'left', clickCount: 1 })
  await until(
    () => wc.executeJavaScript('document.activeElement?.id === "field"') as Promise<boolean>,
    'native browser click did not focus the field',
  )
  for (const character of 'hello browser') wc.sendInputEvent({ type: 'char', keyCode: character })
  await until(
    () =>
      wc.executeJavaScript(
        'document.querySelector("#field").value === "hello browser"',
      ) as Promise<boolean>,
    'native keyboard input did not reach the browser',
  )
  wc.sendInputEvent({ type: 'mouseWheel', x: 250, y: 200, deltaY: -480, canScroll: true })
  await until(
    () => wc.executeJavaScript('scrollY > 0') as Promise<boolean>,
    'native wheel did not scroll the browser',
  )
  await wc.executeJavaScript(`(async () => {
    // Wait for Chromium's smooth wheel animation before returning to the top.
    await new Promise(resolve => {
      let previous = scrollY, stable = 0;
      const frame = () => {
        stable = scrollY === previous ? stable + 1 : 0;
        previous = scrollY;
        if (stable >= 8) resolve(); else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    scrollTo(0,0)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  assert.equal(await wc.executeJavaScript('scrollY'), 0, 'browser evidence is still scrolled')
  await new Promise((resolve) => setTimeout(resolve, 100))
  // This optional check needs an interactive Windows desktop. Headless
  // launchers can occlude native windows even while their page accepts input.
  if (process.platform === 'win32' && process.env.ARI_BROWSER_NATIVE_CAPTURE === '1') {
    // Check the actual window rather than only the guest's capture surface:
    // an offscreen guest can be captured while never appearing in the panel.
    // DWM can first return a blank thumbnail before its asynchronous repaint.
    let frame: NativeImage | undefined
    try {
      await until(async () => {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 1200, height: 800 },
        })
        const source = sources.find((source) => source.id === win.getMediaSourceId())
        if (!source || source.thumbnail.isEmpty()) return false
        frame = source.thumbnail
        const content = win.getContentBounds()
        const bounds = page.getBounds()
        const size = frame.getSize()
        const x = Math.round(((bounds.x + bounds.width / 2) * size.width) / content.width)
        const y = Math.round(((bounds.y + bounds.height / 2) * size.height) / content.height)
        const pixels = frame.toBitmap()
        const offset = (y * size.width + x) * 4
        return [255, 242, 234].every((value, channel) => {
          const actual = pixels[offset + channel]
          return actual !== undefined && Math.abs(actual - value) <= 5
        })
      }, 'native window did not display the browser page')
    } finally {
      if (frame) {
        const directory = join(process.cwd(), 'out/browser-interaction-evidence')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'native-browser.png'), frame.toPNG())
      }
    }
  }
  if (process.platform === 'win32') win.setAlwaysOnTop(false)
  console.log('E2E PASS Electron native click, typing and scrolling')
}
