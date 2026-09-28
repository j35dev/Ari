import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shell, type WebContents } from 'electron'
import { isAppUrl, isExternalOpenable } from './external-links'

/**
 * Pins the ADE renderer so transcript links cannot replace the app. Must be
 * attached only to a BrowserWindow's own webContents — a WebContentsView
 * guest (the in-app browser) has to navigate http(s) itself.
 */
export function attachAppShellNavigationGuard(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenable(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const appFileUrl = devServerUrl
    ? undefined
    : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url, devServerUrl, appFileUrl)) return
    event.preventDefault()
    if (isExternalOpenable(url)) void shell.openExternal(url)
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
}
