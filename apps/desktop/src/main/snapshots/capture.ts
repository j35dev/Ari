import { desktopCapturer, nativeImage, screen } from 'electron'
import type { SnapshotRectangle } from '../../shared/snapshots'

/** Select by native HWND, never source order or a potentially duplicated title. */
export function sourceMatchesWindow(sourceId: string, windowId: string): boolean {
  return sourceId.split(':')[0] === 'window' && sourceId.split(':')[1] === windowId
}

export function intersectRect(
  first: SnapshotRectangle,
  second: SnapshotRectangle,
): SnapshotRectangle | null {
  const x = Math.max(first.x, second.x)
  const y = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** Some windows are omitted from Electron's window list. Capture only their
 * visible bounds, stitching display intersections in DIP space for mixed DPI. */
async function captureVisibleWindow(bounds: SnapshotRectangle): Promise<Buffer> {
  const displays = screen
    .getAllDisplays()
    .filter((display) => intersectRect(bounds, display.bounds))
  if (!displays.length) throw new Error('The foreground window is outside the visible desktop.')
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(
        ...displays.map((display) => Math.round(display.bounds.width * display.scaleFactor)),
      ),
      height: Math.max(
        ...displays.map((display) => Math.round(display.bounds.height * display.scaleFactor)),
      ),
    },
  })
  const scale = Math.min(
    Math.max(...displays.map((display) => display.scaleFactor)),
    2560 / bounds.width,
    1600 / bounds.height,
  )
  const width = Math.max(1, Math.round(bounds.width * scale))
  const height = Math.max(1, Math.round(bounds.height * scale))
  const bitmap = Buffer.alloc(width * height * 4)
  for (const display of displays) {
    const area = intersectRect(bounds, display.bounds)!
    const source =
      sources.find((item) => item.display_id === String(display.id)) ??
      (displays.length === 1 && sources.length === 1 ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty())
      throw new Error('The foreground display is unavailable for capture.')
    const size = source.thumbnail.getSize()
    const left = Math.max(
      0,
      Math.round(((area.x - display.bounds.x) * size.width) / display.bounds.width),
    )
    const top = Math.max(
      0,
      Math.round(((area.y - display.bounds.y) * size.height) / display.bounds.height),
    )
    const right = Math.min(
      size.width,
      Math.round(((area.x + area.width - display.bounds.x) * size.width) / display.bounds.width),
    )
    const bottom = Math.min(
      size.height,
      Math.round(((area.y + area.height - display.bounds.y) * size.height) / display.bounds.height),
    )
    const outLeft = Math.round((area.x - bounds.x) * scale)
    const outTop = Math.round((area.y - bounds.y) * scale)
    const outWidth = Math.min(
      width - outLeft,
      Math.round((area.x + area.width - bounds.x) * scale) - outLeft,
    )
    const outHeight = Math.min(
      height - outTop,
      Math.round((area.y + area.height - bounds.y) * scale) - outTop,
    )
    if (right <= left || bottom <= top || outWidth <= 0 || outHeight <= 0) continue
    const tile = source.thumbnail
      .crop({ x: left, y: top, width: right - left, height: bottom - top })
      .resize({ width: outWidth, height: outHeight })
      .toBitmap()
    for (let row = 0; row < outHeight; row++)
      tile.copy(
        bitmap,
        ((outTop + row) * width + outLeft) * 4,
        row * outWidth * 4,
        (row + 1) * outWidth * 4,
      )
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}

export async function captureForegroundWindow(): Promise<{
  bytes: Buffer
  windowTitle: string
  bounds: SnapshotRectangle
}> {
  if (process.platform !== 'win32') throw new Error('SnapShots currently supports Windows.')
  const { default: koffi } = await import('koffi')
  const user = koffi.load('user32.dll')
  const foreground = user.func('void* __stdcall GetForegroundWindow()')
  const handle: unknown = foreground()
  if (!handle) throw new Error('No foreground window is available to capture.')
  // Freeze the identity before the async enumeration, and before Ari is revealed.
  const id = koffi.address(handle).toString()
  const rect = Buffer.alloc(16)
  // DWM excludes invisible resize borders. Its rectangle is in physical pixels;
  // Electron overlay/composer coordinates are display-independent pixels.
  const dwmBounds = koffi
    .load('dwmapi.dll')
    .func(
      'int32 __stdcall DwmGetWindowAttribute(void* hwnd, uint32 attribute, _Out_ void* value, uint32 size)',
    )
  if (dwmBounds(handle, 9, rect, rect.length) < 0) {
    const getRect = user.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ void* rect)')
    if (!getRect(handle, rect)) throw new Error('The foreground window bounds are unavailable.')
  }
  const bounds = screen.screenToDipRect(null, {
    x: rect.readInt32LE(0),
    y: rect.readInt32LE(4),
    width: rect.readInt32LE(8) - rect.readInt32LE(0),
    height: rect.readInt32LE(12) - rect.readInt32LE(4),
  })
  if (bounds.width <= 0 || bounds.height <= 0)
    throw new Error('The foreground window is not visible.')
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 2560, height: 1600 },
    fetchWindowIcons: false,
  })
  const source = sources.find((candidate) => sourceMatchesWindow(candidate.id, id))
  if (source && !source.thumbnail.isEmpty())
    return { bytes: source.thumbnail.toPNG(), windowTitle: source.name.slice(0, 512), bounds }
  if (koffi.address(foreground()).toString() !== id)
    throw new Error('The foreground window changed. Try taking the SnapShot again.')
  const bytes = await captureVisibleWindow(bounds)
  if (koffi.address(foreground()).toString() !== id)
    throw new Error('The foreground window changed. Try taking the SnapShot again.')
  const getTitle = user.func(
    'int32 __stdcall GetWindowTextW(void* hwnd, _Out_ void* text, int32 length)',
  )
  const title = Buffer.alloc(1024)
  const length: unknown = getTitle(handle, title, 512)
  const windowTitle =
    typeof length === 'number' ? title.toString('utf16le', 0, length * 2) : 'Window'
  return { bytes, windowTitle, bounds }
}
