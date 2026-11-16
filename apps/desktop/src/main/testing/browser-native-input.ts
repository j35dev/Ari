import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'

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
    scrollTo(0,0)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  if (process.platform === 'win32') {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1200, height: 800 },
    })
    const source = sources.find((source) => source.id === win.getMediaSourceId())
    assert.ok(source && !source.thumbnail.isEmpty(), 'native browser window capture is empty')
    const directory = join(process.cwd(), 'out/browser-interaction-evidence')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'native-browser.png'), source.thumbnail.toPNG())
  }
  console.log('E2E PASS Electron native click, typing and scrolling')
}
