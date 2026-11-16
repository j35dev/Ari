import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, protocol } from 'electron'
import { THEME_ASSET_SCHEME } from '@ari/contracts/themes'
import { ThemeAssetStore, themeAssetMime } from './theme-assets'

let store: ThemeAssetStore | null = null
export function getThemeAssetStore(): ThemeAssetStore {
  return (store ??= new ThemeAssetStore(join(app.getPath('userData'), 'theme-assets')))
}

/** Must run before the app is ready. */
export function registerThemeAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THEME_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

/**
 * Serves stored theme files to the renderer as `ari-theme-asset://a/<sha256>.<ext>`.
 * Only content-hashed names inside the store resolve; an SVG opened as a page
 * runs no script and loads nothing.
 */
export function handleThemeAssets(): void {
  protocol.handle(THEME_ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    const file = url.pathname.replace(/^\/+/, '')
    const path = url.host === 'a' ? getThemeAssetStore().resolve(file) : null
    const bytes = path ? await readFile(path).catch(() => null) : null
    if (!bytes) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type':
          themeAssetMime[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}
