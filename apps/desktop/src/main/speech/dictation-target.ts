import { app, type BrowserWindow } from 'electron'
import type { DictationTarget } from '../../shared/dictation'
import { WindowsDictationService } from './dictation-service'

let windows: WindowsDictationService | undefined

export async function prepareDictation(): Promise<void> {
  if (process.platform === 'win32' && !windows) {
    windows = new WindowsDictationService()
    app.once('will-quit', () => windows?.close())
  }
  await windows?.prepare()
}

export async function captureDictationTarget(
  main: BrowserWindow | null,
  id: string,
): Promise<DictationTarget> {
  if (main && !main.isDestroyed() && main.isFocused() && main.webContents.isFocused()) {
    const contents = main.webContents
    await contents.executeJavaScript(
      `if (!window.ariDictation) throw new Error('Dictation is not ready'); window.ariDictation.capture(${JSON.stringify(id)})`,
    )
    return {
      cancel() {
        if (!contents.isDestroyed())
          void contents
            .executeJavaScript(`window.ariDictation?.cancel(${JSON.stringify(id)})`)
            .catch(() => undefined)
      },
      async insert(text, current = () => true) {
        if (!current() || main.isDestroyed() || !main.isFocused() || contents.isDestroyed())
          throw new Error('The dictation target is no longer focused.')
        await contents.executeJavaScript(
          `window.ariDictation.insert(${JSON.stringify(id)}, ${JSON.stringify(text)})`,
        )
      },
    }
  }
  if (process.platform !== 'win32')
    throw new Error(
      'General dictation outside Ari is currently available on Windows. Focus a text field in Ari.',
    )
  if (!windows) throw new Error('Windows dictation is not available yet. Try again.')
  return windows.capture(id)
}
