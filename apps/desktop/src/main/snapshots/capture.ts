import { nativeImage, screen, desktopCapturer, type NativeImage } from 'electron'
import type { SnapshotRectangle } from '../../shared/snapshots'

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

/** The attachment cap; keeps a 4-MP window from growing into a 100-MP capture. */
const MAX_CAPTURE_WIDTH = 2560
const MAX_CAPTURE_HEIGHT = 1600

/** The overlay thumbnail is ~380 DIP wide; 2x covers HiDPI without a multi-MB payload. */
const PREVIEW_MAX_WIDTH = 800

interface DisplayGeometry {
  bounds: SnapshotRectangle
  scaleFactor: number
}

export interface CaptureTile {
  display: number
  area: SnapshotRectangle
  output: SnapshotRectangle
}

export interface CapturePlan {
  width: number
  height: number
  scale: number
  thumbnailSize: { width: number; height: number }
  tiles: CaptureTile[]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Plan the stitched bitmap and, per display, the sub-rectangles to crop. */
export function planCapture(
  bounds: SnapshotRectangle,
  displays: readonly DisplayGeometry[],
): CapturePlan {
  const tiles: CaptureTile[] = []
  let maxScale = 1
  let thumbnailWidth = 0
  let thumbnailHeight = 0
  displays.forEach((display, index) => {
    const area = intersectRect(bounds, display.bounds)
    if (!area) return
    tiles.push({ display: index, area, output: { x: 0, y: 0, width: 0, height: 0 } })
    maxScale = Math.max(maxScale, display.scaleFactor)
    thumbnailWidth = Math.max(
      thumbnailWidth,
      Math.round(display.bounds.width * display.scaleFactor),
    )
    thumbnailHeight = Math.max(
      thumbnailHeight,
      Math.round(display.bounds.height * display.scaleFactor),
    )
  })
  if (!tiles.length) throw new Error('The foreground window is outside the visible desktop.')
  const scale = Math.min(
    maxScale,
    MAX_CAPTURE_WIDTH / bounds.width,
    MAX_CAPTURE_HEIGHT / bounds.height,
  )
  const width = Math.max(1, Math.round(bounds.width * scale))
  const height = Math.max(1, Math.round(bounds.height * scale))
  for (const tile of tiles) {
    const { area } = tile
    const left = clamp(Math.round((area.x - bounds.x) * scale), 0, width)
    const top = clamp(Math.round((area.y - bounds.y) * scale), 0, height)
    const right = clamp(Math.round((area.x + area.width - bounds.x) * scale), 0, width)
    const bottom = clamp(Math.round((area.y + area.height - bounds.y) * scale), 0, height)
    tile.output = { x: left, y: top, width: right - left, height: bottom - top }
  }
  return {
    width,
    height,
    scale,
    thumbnailSize: { width: Math.max(1, thumbnailWidth), height: Math.max(1, thumbnailHeight) },
    tiles,
  }
}

/** Map the window/display intersection into a screen thumbnail's pixel grid. */
export function sourceCrop(
  area: SnapshotRectangle,
  display: SnapshotRectangle,
  size: { width: number; height: number },
): SnapshotRectangle {
  const left = clamp(Math.round(((area.x - display.x) * size.width) / display.width), 0, size.width)
  const top = clamp(
    Math.round(((area.y - display.y) * size.height) / display.height),
    0,
    size.height,
  )
  const right = clamp(
    Math.round(((area.x + area.width - display.x) * size.width) / display.width),
    0,
    size.width,
  )
  const bottom = clamp(
    Math.round(((area.y + area.height - display.y) * size.height) / display.height),
    0,
    size.height,
  )
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Fallback when the foreground window cannot be printed: crop it out of a
 * single screen frame. The window is on top, so the screen holds the same
 * pixels; this stitches display intersections in DIP space for mixed DPI.
 */
async function captureWindowRegion(bounds: SnapshotRectangle): Promise<NativeImage> {
  const displays = screen.getAllDisplays()
  const plan = planCapture(bounds, displays)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: plan.thumbnailSize,
    fetchWindowIcons: false,
  })
  const bitmap = Buffer.alloc(plan.width * plan.height * 4)
  for (const tile of plan.tiles) {
    if (tile.output.width <= 0 || tile.output.height <= 0) continue
    const display = displays[tile.display]!
    const source =
      sources.find((item) => item.display_id === String(display.id)) ??
      (plan.tiles.length === 1 && sources.length === 1 ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty())
      throw new Error('The foreground display is unavailable for capture.')
    const size = source.thumbnail.getSize()
    const crop = sourceCrop(tile.area, display.bounds, size)
    if (crop.width <= 0 || crop.height <= 0) continue
    let image = source.thumbnail
    if (crop.width !== size.width || crop.height !== size.height) image = image.crop(crop)
    if (
      image.getSize().width !== tile.output.width ||
      image.getSize().height !== tile.output.height
    )
      image = image.resize({ width: tile.output.width, height: tile.output.height })
    const pixels = image.toBitmap()
    const actual = image.getSize()
    const columns = Math.min(actual.width, tile.output.width)
    const rows = Math.min(actual.height, tile.output.height)
    for (let row = 0; row < rows; row++)
      pixels.copy(
        bitmap,
        ((tile.output.y + row) * plan.width + tile.output.x) * 4,
        row * actual.width * 4,
        row * actual.width * 4 + columns * 4,
      )
  }
  return nativeImage.createFromBitmap(bitmap, { width: plan.width, height: plan.height })
}

/** Small data URL for the transient overlay; the full PNG never crosses IPC. */
export function previewDataUrl(image: NativeImage): string {
  const width = image.getSize().width
  if (width <= 0) return ''
  const preview =
    width <= PREVIEW_MAX_WIDTH ? image : image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'good' })
  const jpeg = preview.toJPEG(82)
  if (jpeg.length) return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  return `data:image/png;base64,${preview.toPNG().toString('base64')}`
}

/** Downscale a native-size window bitmap to the attachment cap. */
function limitImage(image: NativeImage): NativeImage {
  const { width, height } = image.getSize()
  const scale = Math.min(1, MAX_CAPTURE_WIDTH / width, MAX_CAPTURE_HEIGHT / height)
  if (scale >= 1) return image
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  })
}

function rectangle(buffer: Buffer): SnapshotRectangle {
  return {
    x: buffer.readInt32LE(0),
    y: buffer.readInt32LE(4),
    width: buffer.readInt32LE(8) - buffer.readInt32LE(0),
    height: buffer.readInt32LE(12) - buffer.readInt32LE(4),
  }
}

/** A failed PrintWindow (elevated or protected windows) leaves an all-zero DIB. */
function hasContent(pixels: Buffer): boolean {
  for (let index = 0; index < pixels.length; index += 4096) if (pixels[index]) return true
  return false
}

interface NativeWindowApi {
  foreground(): unknown
  identity(handle: unknown): string
  visibleBounds(handle: unknown): SnapshotRectangle
  title(handle: unknown): string
  hung(handle: unknown): boolean
  /** Native-size pixels straight from the window; null when unavailable. */
  capture(handle: unknown, visible: SnapshotRectangle): NativeImage | null
}

let nativeWindowApi: Promise<NativeWindowApi> | null = null

function loadNativeWindowApi(): Promise<NativeWindowApi> {
  nativeWindowApi ??= (async () => {
    const { default: koffi } = await import('koffi')
    const user = koffi.load('user32.dll')
    const dwm = koffi.load('dwmapi.dll')
    const gdi = koffi.load('gdi32.dll')
    const foreground = user.func('void* __stdcall GetForegroundWindow()')
    const getRect = user.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ void* rect)')
    const getTitle = user.func(
      'int32 __stdcall GetWindowTextW(void* hwnd, _Out_ void* text, int32 length)',
    )
    const dwmBounds = dwm.func(
      'int32 __stdcall DwmGetWindowAttribute(void* hwnd, uint32 attribute, _Out_ void* value, uint32 size)',
    )
    const isHung = user.func('bool __stdcall IsHungAppWindow(void* hwnd)')
    const printWindow = user.func(
      'int32 __stdcall PrintWindow(void* hwnd, void* hdc, uint32 flags)',
    )
    const getDC = user.func('void* __stdcall GetDC(void* hwnd)')
    const releaseDC = user.func('int32 __stdcall ReleaseDC(void* hwnd, void* hdc)')
    const createCompatibleDC = gdi.func('void* __stdcall CreateCompatibleDC(void* hdc)')
    const createCompatibleBitmap = gdi.func(
      'void* __stdcall CreateCompatibleBitmap(void* hdc, int32 width, int32 height)',
    )
    const selectObject = gdi.func('void* __stdcall SelectObject(void* hdc, void* object)')
    const deleteObject = gdi.func('int32 __stdcall DeleteObject(void* object)')
    const deleteDC = gdi.func('int32 __stdcall DeleteDC(void* hdc)')
    const getDIBits = gdi.func(
      'int32 __stdcall GetDIBits(void* hdc, void* bitmap, uint32 start, uint32 lines, _Out_ void* bits, void* info, uint32 usage)',
    )

    function windowRect(handle: unknown): SnapshotRectangle {
      const rect = Buffer.alloc(16)
      if (!getRect(handle, rect)) throw new Error('The foreground window bounds are unavailable.')
      return rectangle(rect)
    }

    function pixels(handle: unknown, width: number, height: number): Buffer | null {
      const screenDC: unknown = getDC(null)
      if (!screenDC) return null
      const memory: unknown = createCompatibleDC(screenDC)
      if (!memory) {
        releaseDC(null, screenDC)
        return null
      }
      const bitmap: unknown = createCompatibleBitmap(screenDC, width, height)
      if (!bitmap) {
        deleteDC(memory)
        releaseDC(null, screenDC)
        return null
      }
      const previous: unknown = selectObject(memory, bitmap)
      try {
        // PW_RENDERFULLCONTENT renders DWM-composited windows, not just GDI output.
        if (!printWindow(handle, memory, 2)) return null
        const info = Buffer.alloc(40)
        info.writeUInt32LE(40, 0)
        info.writeInt32LE(width, 4)
        info.writeInt32LE(-height, 8) // top-down rows, matching Electron bitmaps
        info.writeUInt16LE(1, 12)
        info.writeUInt16LE(32, 14)
        const out = Buffer.alloc(width * height * 4)
        return getDIBits(memory, bitmap, 0, height, out, info, 0) === height ? out : null
      } finally {
        if (previous) selectObject(memory, previous)
        deleteObject(bitmap)
        deleteDC(memory)
        releaseDC(null, screenDC)
      }
    }

    return {
      foreground,
      identity: (handle) => koffi.address(handle).toString(),
      visibleBounds(handle) {
        const rect = Buffer.alloc(16)
        // DWM excludes invisible resize borders. Its rectangle is in physical
        // pixels; Electron overlay/composer coordinates are display-independent.
        if (dwmBounds(handle, 9, rect, rect.length) < 0 && !getRect(handle, rect))
          throw new Error('The foreground window bounds are unavailable.')
        return rectangle(rect)
      },
      title(handle) {
        const text = Buffer.alloc(1024)
        const length: unknown = getTitle(handle, text, 512)
        return typeof length === 'number' ? titleText(text, length) : 'Window'
      },
      hung: (handle) => Boolean(isHung(handle)),
      capture(handle, visible) {
        const window = windowRect(handle)
        // Back off pathological allocations; the screen path caps itself.
        if (window.width <= 0 || window.height <= 0) return null
        if (window.width > 8192 || window.height > 8192) return null
        const bitmap = pixels(handle, window.width, window.height)
        if (!bitmap || !hasContent(bitmap)) return null
        const image = nativeImage.createFromBitmap(bitmap, {
          width: window.width,
          height: window.height,
        })
        const x = clamp(visible.x - window.x, 0, window.width - 1)
        const y = clamp(visible.y - window.y, 0, window.height - 1)
        const width = clamp(visible.width, 1, window.width - x)
        const height = clamp(visible.height, 1, window.height - y)
        return limitImage(
          x || y || width !== window.width || height !== window.height
            ? image.crop({ x, y, width, height })
            : image,
        )
      },
    }
  })()
  nativeWindowApi.catch(() => {
    nativeWindowApi = null
  })
  return nativeWindowApi
}

function titleText(text: Buffer, length: number): string {
  return text.toString('utf16le', 0, length * 2)
}

export interface CapturedWindow {
  /** Decoded pixels; the caller encodes only after showing first feedback. */
  image: NativeImage
  previewDataUrl: string
  windowTitle: string
  bounds: SnapshotRectangle
}

export async function captureForegroundWindow(): Promise<CapturedWindow> {
  if (process.platform !== 'win32') throw new Error('SnapShots currently supports Windows.')
  const native = await loadNativeWindowApi()
  const handle = native.foreground()
  if (!handle) throw new Error('No foreground window is available to capture.')
  // Freeze the identity before the async capture; the user may alt-tab mid-way.
  const id = native.identity(handle)
  const visible = native.visibleBounds(handle)
  const bounds = screen.screenToDipRect(null, visible)
  if (bounds.width <= 0 || bounds.height <= 0)
    throw new Error('The foreground window is not visible.')
  // A hung window would block PrintWindow, and elevated/protected windows can
  // come back blank; both fall back to a screen frame, which is much slower.
  let image: NativeImage | null = null
  if (!native.hung(handle)) {
    try {
      image = native.capture(handle, visible)
    } catch {
      image = null
    }
  }
  image ??= await captureWindowRegion(bounds)
  if (native.identity(native.foreground()) !== id)
    throw new Error('The foreground window changed. Try taking the SnapShot again.')
  return {
    image,
    previewDataUrl: previewDataUrl(image),
    windowTitle: native.title(handle),
    bounds,
  }
}
