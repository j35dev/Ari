// @vitest-environment node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { grantSpeechMicrophone, isSpeechPage } from './permissions'

const switches = vi.hoisted(() => ({ hasSwitch: vi.fn(() => false) }))
vi.mock('electron', () => ({ app: { commandLine: switches } }))
afterEach(() => {
  switches.hasSwitch.mockReturnValue(false)
  vi.unstubAllEnvs()
})

it('grants speech only to Ari pages and its configured development origin', () => {
  expect(isSpeechPage('https://example.com/index.html', '')).toBe(false)
  expect(isSpeechPage('file:///C:/Downloads/other.html', '')).toBe(false)
  expect(isSpeechPage('http://localhost:5173/index.html', 'http://localhost:5173')).toBe(true)
  expect(isSpeechPage('http://localhost:5174/index.html', 'http://localhost:5173')).toBe(false)
  expect(isSpeechPage('not a URL', '')).toBe(false)
  const entry = 'file:///C:/Ari/renderer/index.html'
  const widget = 'file:///C:/Ari/renderer/widget/index.html'
  const entries = [entry, widget]
  expect(isSpeechPage(`${entry}#/settings`, '', entries)).toBe(true)
  // The packaged hold-to-talk widget records too.
  expect(isSpeechPage(widget, '', entries)).toBe(true)
  expect(isSpeechPage('file:///C:/Ari/renderer/index.html.evil', '', entries)).toBe(false)
  expect(isSpeechPage('file:///C:/Ari/renderer/other.html', '', entries)).toBe(false)
  expect(isSpeechPage('file:///C:/Ari/renderer/widget/other.html', '', entries)).toBe(false)
  expect(isSpeechPage('about:blank', '', entries)).toBe(false)
})

it('defaults to the main window and widget entry files', () => {
  expect(
    isSpeechPage(
      pathToFileURL(join(import.meta.dirname, '../renderer/widget/index.html')).href,
      '',
    ),
  ).toBe(true)
  expect(
    isSpeechPage(pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href, ''),
  ).toBe(true)
})

it('preserves Electron default clipboard and ordinary permission decisions', () => {
  const request = vi.fn()
  const check = vi.fn()
  grantSpeechMicrophone({
    setPermissionRequestHandler: request,
    setPermissionCheckHandler: check,
  } as unknown as Session)
  const contents = { getURL: () => 'https://example.com' }
  for (const permission of [
    'clipboard-read',
    'clipboard-sanitized-write',
    'notifications',
    'geolocation',
  ]) {
    const callback = vi.fn()
    request.mock.calls[0]![0](contents, permission, callback, {})
    expect(callback).toHaveBeenCalledWith(true)
    expect(check.mock.calls[0]![0](contents, permission, '', {})).toBe(true)
  }
  expect(check.mock.calls[0]![0](contents, 'deprecated-sync-clipboard-read', '', {})).toBe(false)
  switches.hasSwitch.mockReturnValue(true)
  const callback = vi.fn()
  request.mock.calls[0]![0](contents, 'geolocation', callback, {})
  expect(callback).toHaveBeenCalledWith(false)
  expect(check.mock.calls[0]![0](contents, 'geolocation', '', {})).toBe(false)
})

it('grants audio only when both the top page and requesting page are trusted', () => {
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  const request = vi.fn()
  const check = vi.fn()
  grantSpeechMicrophone({
    setPermissionRequestHandler: request,
    setPermissionCheckHandler: check,
  } as unknown as Session)
  const url = pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  const contents = { getURL: () => url }
  const callback = vi.fn()
  request.mock.calls[0]![0](contents, 'media', callback, {
    requestingUrl: url,
    mediaTypes: ['audio'],
  })
  expect(callback).toHaveBeenLastCalledWith(true)
  request.mock.calls[0]![0](contents, 'media', callback, {
    requestingUrl: url,
    mediaTypes: ['video'],
  })
  expect(callback).toHaveBeenLastCalledWith(false)
  request.mock.calls[0]![0](contents, 'media', callback, {
    requestingUrl: `${url}.evil`,
    mediaTypes: ['audio'],
  })
  expect(callback).toHaveBeenLastCalledWith(false)
  expect(
    check.mock.calls[0]![0](contents, 'media', '', { requestingUrl: url, mediaType: 'audio' }),
  ).toBe(true)
  expect(
    check.mock.calls[0]![0](contents, 'media', '', { requestingUrl: url, mediaType: 'video' }),
  ).toBe(false)
  for (const mediaType of ['unknown', undefined]) {
    expect(check.mock.calls[0]![0](contents, 'media', '', { requestingUrl: url, mediaType })).toBe(
      true,
    )
    expect(
      check.mock.calls[0]![0]({ getURL: () => 'https://example.com' }, 'media', '', {
        requestingUrl: url,
        mediaType,
      }),
    ).toBe(false)
  }
  expect(
    check.mock.calls[0]![0](null, 'media', '', { requestingUrl: url, mediaType: 'audio' }),
  ).toBe(false)
})
