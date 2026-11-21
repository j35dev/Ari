import { BrowserWindow, screen, systemPreferences } from 'electron'
import type { Settings } from '@ari/contracts/settings'
import type { SnapshotRectangle } from '../../shared/snapshots'
import { snapshotFlightFrames, SNAPSHOT_FLIGHT_DURATION } from '../../shared/snapshot-flight'
import { SNAPSHOT_OVERLAY_HTML } from './overlay-html'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:snapshots-overlay')

interface OverlayCapture {
  id: string
  /** Downscaled data URL; the full-size PNG never crosses IPC for feedback. */
  image: string
  bounds: SnapshotRectangle
}
interface ActiveOverlay {
  capture: OverlayCapture
  settings: Settings
  bounds: SnapshotRectangle
  workArea: SnapshotRectangle
  destination?: SnapshotRectangle
  attached: boolean
  loaded: boolean
  deadline: ReturnType<typeof setTimeout>
}

export function containsPoint(rect: SnapshotRectangle, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

/** Back-to-back captures reuse the hidden window instead of paying for a new renderer. */
const IDLE_WINDOW_MS = 60_000

/** Native feedback stays above the source app without ever activating Ari. */
export class SnapshotOverlay {
  private window: BrowserWindow | null = null
  private ready: Promise<BrowserWindow> | null = null
  private active: ActiveOverlay | null = null
  private idle: ReturnType<typeof setTimeout> | null = null

  /**
   * Begin the hidden window's creation and page load now, so it runs in
   * parallel with the capture. Only ever called per capture: an idle window is
   * torn down instead of living for the whole session.
   */
  prepare(): void {
    void this.ensureWindow().catch((error: unknown) =>
      log.warn('desktop feedback prewarm failed', { error: String(error) }),
    )
  }

  private ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      this.cancelIdle()
      return this.ready!
    }
    this.cancelIdle()
    const window = new BrowserWindow({
      ...this.desktopBounds(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: {
        partition: 'snapshots-feedback',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setIgnoreMouseEvents(true, { forward: true })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.once('closed', () => {
      if (this.window === window) {
        this.window = null
        this.ready = null
      }
      if (this.active) this.finish(this.active)
    })
    this.window = window
    this.ready = window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SNAPSHOT_OVERLAY_HTML)}`)
      .then(() => window)
      .catch((error: unknown) => {
        if (this.window === window) {
          this.window = null
          this.ready = null
        }
        throw error
      })
    return this.ready
  }

  show(capture: OverlayCapture, settings: Settings): void {
    this.hide()
    if (!settings.snapshots.animation && !settings.snapshots.sound) return
    const active: ActiveOverlay = {
      capture,
      settings,
      bounds: this.desktopBounds(),
      workArea: screen.getDisplayMatching(capture.bounds).workArea,
      attached: false,
      loaded: false,
      deadline: setTimeout(() => this.finish(active), 5000),
    }
    this.active = active
    void this.present(active).catch((error: unknown) => {
      log.warn('desktop feedback failed', { error: String(error) })
      this.finish(active)
    })
  }

  private async present(active: ActiveOverlay): Promise<void> {
    const window = await this.ensureWindow()
    if (this.active !== active || window.isDestroyed()) return
    if (!matches(window.getBounds(), active.bounds)) window.setBounds(active.bounds)
    // The window is reused, so clear the previous flight while it is still hidden.
    await window.webContents.executeJavaScript('window.resetSnapshotFeedback()')
    if (this.active !== active) return
    active.loaded = true
    // showInactive and focusable:false preserve the foreground app and caret.
    if (active.settings.snapshots.animation) window.showInactive()
    if (active.attached) await window.webContents.executeJavaScript('window.snapshotAttached()')
    await window.webContents.executeJavaScript(
      `window.beginSnapshotFeedback(${JSON.stringify(this.presentation(active))})`,
    )
    this.finish(active)
  }

  destination(id: string, rectangle: SnapshotRectangle): void {
    const active = this.active
    if (!active || active.capture.id !== id) return
    active.destination = rectangle
    if (active.loaded) {
      const presentation = this.presentation(active)
      // The image is already decoded in the overlay; destination updates only
      // need geometry and animation frames, not another payload.
      presentation.image = ''
      void this.window?.webContents
        .executeJavaScript(`window.updateSnapshotDestination(${JSON.stringify(presentation)})`)
        .catch(() => undefined)
    }
  }

  acknowledge(id: string): void {
    const active = this.active
    if (!active || active.capture.id !== id) return
    active.attached = true
    if (active.loaded)
      void this.window?.webContents
        .executeJavaScript('window.snapshotAttached()')
        .catch(() => undefined)
  }

  /** Remove visible feedback; the window hides now and is destroyed after a minute idle. */
  hide(): void {
    if (this.active) this.finish(this.active)
    else if (this.window && !this.window.isDestroyed()) {
      this.window.hide()
      this.scheduleIdle()
    }
  }

  private finish(active: ActiveOverlay): void {
    clearTimeout(active.deadline)
    if (this.active !== active) return
    this.active = null
    if (this.window && !this.window.isDestroyed()) this.window.hide()
    this.scheduleIdle()
  }

  /** Keep the hidden window briefly for the next capture, then release its renderer. */
  private scheduleIdle(): void {
    this.cancelIdle()
    if (!this.window || this.window.isDestroyed()) return
    this.idle = setTimeout(() => {
      this.idle = null
      this.destroyWindow()
    }, IDLE_WINDOW_MS)
  }

  private cancelIdle(): void {
    if (!this.idle) return
    clearTimeout(this.idle)
    this.idle = null
  }

  private destroyWindow(): void {
    this.cancelIdle()
    const window = this.window
    this.window = null
    this.ready = null
    if (window && !window.isDestroyed()) window.destroy()
  }

  private desktopBounds(): SnapshotRectangle {
    const displays = screen.getAllDisplays()
    const left = Math.min(...displays.map((display) => display.bounds.x))
    const top = Math.min(...displays.map((display) => display.bounds.y))
    return {
      x: left,
      y: top,
      width: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) - left,
      height:
        Math.max(...displays.map((display) => display.bounds.y + display.bounds.height)) - top,
    }
  }

  private presentation(active: ActiveOverlay) {
    const { capture, bounds, workArea, destination, settings } = active
    const width = Math.min(380, capture.bounds.width * 0.48, workArea.width * 0.38)
    const height = Math.min(
      (width * capture.bounds.height) / capture.bounds.width,
      workArea.height * 0.36,
    )
    const from = {
      x: capture.bounds.x + capture.bounds.width / 2 - bounds.x,
      y: capture.bounds.y + capture.bounds.height / 2 - bounds.y,
    }
    const receipt = {
      x: workArea.x + workArea.width - 212 - bounds.x,
      y: workArea.y + workArea.height - 68 - bounds.y,
    }
    const to = destination
      ? {
          x: destination.x + destination.width / 2 - bounds.x,
          y: destination.y + destination.height / 2 - bounds.y,
        }
      : { x: receipt.x + 24, y: receipt.y + 24 }
    const reducedMotion =
      settings.appearance.reducedMotion ||
      systemPreferences.getAnimationSettings().prefersReducedMotion
    return {
      width,
      height,
      left: from.x - width / 2,
      top: from.y - width / 2,
      receipt,
      image: capture.image,
      animation: settings.snapshots.animation,
      sound: settings.snapshots.sound,
      reducedMotion,
      composer: Boolean(destination),
      duration: SNAPSHOT_FLIGHT_DURATION,
      frames: snapshotFlightFrames({
        from,
        to,
        width,
        height,
        destinationWidth: destination?.width ?? 28,
        destinationHeight: destination?.height ?? 28,
      }),
    }
  }

  dispose(): void {
    if (this.active) {
      clearTimeout(this.active.deadline)
      this.active = null
    }
    this.destroyWindow()
  }
}

function matches(first: SnapshotRectangle, second: SnapshotRectangle): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  )
}
