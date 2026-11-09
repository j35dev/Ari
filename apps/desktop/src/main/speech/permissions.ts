import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Session } from 'electron'

export function isSpeechPage(url: string, devUrl = process.env['ELECTRON_RENDERER_URL']): boolean {
  try {
    const page = new URL(url)
    if (devUrl) return page.origin === new URL(devUrl).origin
    const root = pathToFileURL(join(import.meta.dirname, '../renderer/')).href
    return (
      page.protocol === 'file:' && page.href.startsWith(root) && page.pathname.endsWith('.html')
    )
  } catch {
    return false
  }
}

export function grantSpeechMicrophone(session: Session): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permission === 'media' &&
        isSpeechPage(contents.getURL()) &&
        isSpeechPage(details.requestingUrl) &&
        'mediaTypes' in details &&
        details.mediaTypes?.every((kind) => kind === 'audio') === true,
    )
  })
  session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'media' &&
      contents !== null &&
      isSpeechPage(contents.getURL()) &&
      isSpeechPage(details.requestingUrl ?? contents.getURL()) &&
      details.mediaType !== 'video',
  )
}
