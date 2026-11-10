import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, ipcMain, clipboard } from 'electron'
import koffi from 'koffi'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { AriaWidget } from '../aria-widget'
import { withInjectedKeys } from '../aria-widget/injected-keys'
import { defaultSettings } from '@ari/contracts/settings'
import { WindowsDictationService } from './dictation-service'

const syntheticMicrophone = `navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext(); const oscillator = context.createOscillator();
  oscillator.frequency.value = 440; const destination = context.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start();
  const stream = destination.stream; const stop = stream.getTracks()[0].stop.bind(stream.getTracks()[0]);
  stream.getTracks()[0].stop = () => { stop(); oscillator.stop(); void context.close(); };
  return stream;
}; void 0`
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(test: () => Promise<boolean> | boolean, description: string): Promise<void> {
  const until = Date.now() + 10_000
  while (!(await test())) {
    if (Date.now() > until) throw new Error(`Timed out: ${description}`)
    await delay(50)
  }
}

async function run(): Promise<void> {
  if (process.env['ARIA_DICTATION_VISIBLE_FIXTURE'] !== '1')
    throw new Error(
      'This check opens visible fixtures. Run only with explicit approval and ARIA_DICTATION_VISIBLE_FIXTURE=1.',
    )
  const directory = join(process.cwd(), 'out/dictation-evidence')
  await mkdir(directory, { recursive: true })
  app.setPath('userData', join(directory, 'userData'))
  await app.whenReady()
  const originalClipboard = new Map(
    clipboard.availableFormats().map((format) => [format, clipboard.readBuffer(format)]),
  )
  const user = koffi.load('user32.dll')
  const foreground = user.func('void* __stdcall GetForegroundWindow()')
  const setForeground = user.func('bool __stdcall SetForegroundWindow(void* window)')
  const title = user.func(
    'int __stdcall GetWindowTextW(void* window, _Out_ char16_t* text, int size)',
  )
  const originalFocus: unknown = foreground()
  const main = new BrowserWindow({
    width: 1000,
    height: 650,
    title: 'Ari dictation integration fixture',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  main.webContents.on('console-message', (_event, _level, message) =>
    console.log('renderer:', message),
  )
  const status = { ready: true, engine: 'ready', model: { installed: { path: 'synthetic.gguf' } } }
  const sent: unknown[] = []
  const widget = new AriaWidget({
    mainWindow: () => main,
    openSettings() {},
    invoke: (method, params) => {
      if (method === 'speech.status') return Promise.resolve(status)
      if (method === 'speech.transcribe') return Promise.resolve({ text: 'dictated' })
      if (method === 'aria.open') return Promise.resolve({ sessionId: 'aria-only-fixture' })
      if (method === 'command.dispatch') {
        sent.push(params)
        return Promise.resolve({ accepted: true })
      }
      return Promise.reject(new Error(`Unexpected method ${method}`))
    },
  })
  for (const method of ['speech.status', 'stream.subscribe', 'stream.unsubscribe'])
    ipcMain.handle(`ari:${method}`, () => status)
  ipcMain.handle('ari:speech.transcribe', () => ({ text: 'dictated' }))
  await main.loadFile(join(import.meta.dirname, '../dictation-renderer/testing/dictation.html'))
  await main.webContents.executeJavaScript(syntheticMicrophone)
  await wait(
    () =>
      main.webContents.executeJavaScript(
        `!!document.querySelector('[aria-label="Dictate a message"]:not([disabled])')`,
      ),
    'ready composer',
  )
  const setupDraft = async (): Promise<void> => {
    main.show()
    main.focus()
    main.webContents.focus()
    await main.webContents
      .executeJavaScript(`(() => { const field = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'before OLD after');
      field.dispatchEvent(new Event('input', { bubbles: true })); field.focus(); field.setSelectionRange(7, 10); })()`)
  }
  const draft = (): Promise<string> =>
    main.webContents.executeJavaScript(`document.querySelector('textarea').value`)
  if (!process.env['ARIA_DICTATION_NATIVE_ONLY']) {
    await setupDraft()
    await main.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Dictate a message"]').click()`,
    )
    await wait(
      () =>
        main.webContents.executeJavaScript(
          `!!document.querySelector('[aria-label="Stop dictation"]')`,
        ),
      'recording composer',
    )
    await delay(150)
    await main.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Stop dictation"]').click()`,
    )
    await wait(async () => (await draft()) === 'before dictated after', 'composer draft insertion')
    assert.equal(
      await main.webContents.executeJavaScript(`document.querySelector('textarea').selectionStart`),
      15,
    )
    await writeFile(join(directory, 'composer.png'), (await main.webContents.capturePage()).toPNG())
    console.log(
      'PASS real React composer + recorder/worklet + preload IPC; synthetic microphone and transcription',
    )
  }

  try {
    await widget.configure({
      ...defaultSettings,
      speech: {
        ...defaultSettings.speech,
        enabled: true,
        shortcut: 'f24',
        dictationShortcut: 'f23',
      },
    })
    const pill = BrowserWindow.getAllWindows().find((win) => win !== main)!
    await pill.webContents.executeJavaScript(syntheticMicrophone)
    const hold = async (key: number): Promise<void> => {
      await withInjectedKeys(uIOhook, [key], async () => {
        try {
          await wait(
            () =>
              pill.webContents.executeJavaScript(
                `document.querySelector('.aria-pill')?.dataset.phase === 'listening'`,
              ),
            'listening pill',
          )
        } catch (error) {
          console.log('Pill:', await pill.webContents.executeJavaScript(`document.body.innerText`))
          throw error
        }
        assert.equal(pill.isFocused(), false)
        await delay(200)
      })
    }
    if (!process.env['ARIA_DICTATION_NATIVE_ONLY']) {
      await setupDraft()
      await hold(UiohookKey.F23)
      await wait(
        async () => (await draft()) === 'before dictated after',
        'general in-app insertion',
      )
      assert.equal(sent.length, 0)
      console.log(
        'PASS native general shortcut targets focused composer/caret without sending to Aria',
      )
      await hold(UiohookKey.F24)
      await wait(() => sent.length === 1, 'Aria dispatch')
      assert.deepEqual(sent[0], {
        command: {
          type: 'message.enqueue',
          sessionId: 'aria-only-fixture',
          text: 'dictated',
          attachments: [],
        },
      })
      assert.equal(await draft(), 'before dictated after')
      console.log('PASS native Aria shortcut dispatches to Aria only; composer preserved')
    }

    // Launch a uniquely named scratch file. Never interact with another Notepad tab.
    const scratch = `ari-dictation-routing-check-${Date.now()}.txt`
    await writeFile(join(directory, scratch), 'before OLD after')
    spawn('notepad.exe', [join(directory, scratch)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    let external: unknown
    await wait(() => {
      const window: unknown = foreground()
      if (!window) return false
      const buffer = Buffer.alloc(1024)
      title(window, buffer, 512)
      if (!buffer.toString('utf16le').includes(scratch)) return false
      external = window
      return true
    }, 'scratch Notepad focused')
    await delay(300)
    const native = new WindowsDictationService()
    const inspector = await native.capture('before-check')
    const before = await native.snapshot('before-check')
    inspector.cancel()
    await hold(UiohookKey.F23)
    await wait(
      () =>
        pill.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Inserted"]')`),
      'external inserted pill',
    )
    assert.equal(koffi.address(foreground()), koffi.address(external))
    assert.equal(sent.length, process.env['ARIA_DICTATION_NATIVE_ONLY'] ? 0 : 1)
    const afterTarget = await native.capture('after-check')
    const after = await native.snapshot('after-check')
    afterTarget.cancel()
    assert.equal(
      after.text,
      before.text.slice(0, before.start) + 'dictated' + before.text.slice(before.end),
    )
    assert.equal(after.start, before.start + 'dictated'.length)
    assert.equal(after.start, after.end)
    for (const [format, buffer] of originalClipboard)
      assert.deepEqual(clipboard.readBuffer(format), buffer, `clipboard ${format}`)
    assert.deepEqual(clipboard.availableFormats().sort(), [...originalClipboard.keys()].sort())
    console.log(
      'PASS native general shortcut inserted synthetic text into scratch Notepad; focus and every clipboard format preserved',
    )
    // A deliberate application switch must invalidate even a subsequently restored target.
    const stale = await native.capture('stale-check')
    assert.ok(
      setForeground(koffi.decode(main.getNativeWindowHandle(), 'void*')),
      'fixture must actually gain native foreground focus',
    )
    await delay(200)
    assert.notEqual(
      koffi.address(foreground()),
      koffi.address(external),
      'prove focus changed before expecting rejection',
    )
    assert.ok(setForeground(external))
    await delay(200)
    await assert.rejects(stale.insert('MUST NOT INSERT'), /target changed/)
    native.close()
    console.log('PASS external target rejects focus loss and restoration')
    await writeFile(
      join(directory, 'verification.txt'),
      'Real Electron 43.4.1, uiohook, UI Automation and SendInput checks passed. Microphone/transcription were synthetic. Scratch Notepad left open for review.\n',
    )
  } finally {
    widget.close()
    main.destroy()
    for (const method of [
      'speech.status',
      'speech.transcribe',
      'stream.subscribe',
      'stream.unsubscribe',
    ])
      ipcMain.removeHandler(`ari:${method}`)
    if (originalFocus) setForeground(originalFocus)
  }
}

void run().then(
  () => app.exit(0),
  (error) => {
    console.error(error)
    app.exit(1)
  },
)
