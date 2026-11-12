import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { finalizeDictation } from '../../shared/dictation-format'

// Hidden real-Electron composer check. No native shortcut hook, real microphone, or model download.
// Build the desktop + dictation-fixture.config.ts, then bundle this file with Vite's SSR build.
const transcripts = [
  'okay so i checked the build and it works now i want to review the errors can you help me with that',
  'new paragraph i need three things first run the tests second check the logs third update the README',
]

async function run(): Promise<void> {
  const directory = join(process.cwd(), 'out/dictation-formatting-evidence')
  await mkdir(directory, { recursive: true })
  app.setPath('userData', await mkdtemp(join(directory, 'profile-')))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  await app.whenReady()
  const main = new BrowserWindow({
    show: false,
    width: 1100,
    height: 700,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true,
    },
  })
  const results: { raw: string; text: string }[] = []
  for (const method of ['speech.status', 'stream.subscribe', 'stream.unsubscribe'])
    ipcMain.handle(`ari:${method}`, () => ({ ready: true, engine: 'ready', model: null }))
  ipcMain.handle('ari:speech.transcribe', () => {
    const raw = transcripts[results.length]!
    const text = finalizeDictation(raw, { spokenFormatting: true, language: 'en' })
    results.push({ raw, text })
    return { text }
  })
  ipcMain.handle('ari:fs.list', () => [])
  ipcMain.handle('ari:speechCapture.acquire', () => 'fixture-capture')
  ipcMain.handle('ari:speechCapture.release', () => undefined)
  await main.loadFile(join(import.meta.dirname, '../dictation-renderer/testing/dictation.html'))
  await main.webContents.executeJavaScript(`
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const stream = destination.stream;
      const originalStop = stream.getTracks()[0].stop.bind(stream.getTracks()[0]);
      stream.getTracks()[0].stop = () => { originalStop(); oscillator.stop(); void context.close(); };
      return stream;
    };
    document.body.style.padding = '60px';
    document.body.style.background = 'var(--color-surface-0)';
  `)
  const waitFor = async (expression: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!(await main.webContents.executeJavaScript(expression))) {
      assert.ok(Date.now() < deadline, `Timed out: ${expression}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const field = `document.querySelector('[aria-label="Message"]')`
  const read = (): Promise<{ text: string; cursor: number }> =>
    main.webContents.executeJavaScript(
      `({ text: ${field}.value, cursor: ${field}.selectionStart })`,
    )
  await waitFor(`!!${field}`)
  for (let i = 0; i < 2; i++) {
    await main.webContents.executeJavaScript(
      `${field}.focus(); document.querySelector('[aria-label="Dictate a message"]').click()`,
    )
    await waitFor(`!!document.querySelector('[aria-label="Stop dictation"]')`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await main.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))`,
    )
    await waitFor(`document.querySelector('[aria-label="Dictate a message"]')?.disabled === false`)
    const expected = results.map((result) => result.text).join('')
    const actual = await read()
    assert.equal(actual.text, expected)
    assert.equal(actual.cursor, expected.length)
    await waitFor(
      `JSON.parse(localStorage.getItem('ari.drafts') ?? '{}')['dictation-native-fixture'] === ${JSON.stringify(expected)}`,
    )
  }
  const actual = await read()
  assert.equal(results.length, 2)
  await main.webContents.executeJavaScript(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
  const image = await main.webContents.capturePage()
  await writeFile(join(directory, 'composer.png'), image.toPNG())
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({ results, composer: actual }, null, 2),
  )
  console.log(
    'PASS real Electron composer: synthetic audio capture, finalized formatting, repeated insertion, paragraph/list structure and caret. Evidence:',
    directory,
  )
  main.destroy()
  app.quit()
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
