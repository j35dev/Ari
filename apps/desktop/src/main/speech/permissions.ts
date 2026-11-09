import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, type Session } from 'electron'
import { isAppUrl } from '../external-links'

/** The two pages that record: the main window and the hold-to-talk widget. */
const SPEECH_ENTRIES = ['../renderer/index.html', '../renderer/widget/index.html']

export function isSpeechPage(
  url: string,
  devUrl = process.env['ELECTRON_RENDERER_URL'],
  appFileUrls = SPEECH_ENTRIES.map((entry) => pathToFileURL(join(import.meta.dirname, entry)).href),
): boolean {
  try {
    const page = new URL(url)
    return (
      ['file:', 'http:', 'https:'].includes(page.protocol) &&
      appFileUrls.some((appFileUrl) => isAppUrl(url, devUrl, appFileUrl))
    )
  } catch {
    return false
  }
}

export function grantSpeechMicrophone(session: Session): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') {
      // No handler preceded speech: Electron 43 grants ordinary requests by
      // default, except geolocation disabled through its command-line switch.
      callback(permission !== 'geolocation' || !app.commandLine.hasSwitch('disable-geolocation'))
      return
    }
    callback(
      isSpeechPage(contents.getURL()) &&
        isSpeechPage(details.requestingUrl) &&
        'mediaTypes' in details &&
        details.mediaTypes?.every((kind) => kind === 'audio') === true,
    )
  })
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== 'media')
      return (
        permission !== 'deprecated-sync-clipboard-read' &&
        (permission !== 'geolocation' || !app.commandLine.hasSwitch('disable-geolocation'))
      )
    return (
      contents !== null &&
      isSpeechPage(contents.getURL()) &&
      isSpeechPage(details.requestingUrl ?? contents.getURL()) &&
      details.mediaType !== 'video'
    )
  })
}
