import { BrowserWindow, screen, systemPreferences } from 'electron'
import type { Settings } from '@ari/contracts/settings'
import type { SnapshotRectangle } from '../../shared/snapshots'
import { snapshotFlightFrames, SNAPSHOT_FLIGHT_DURATION } from '../../shared/snapshot-flight'
import { SNAPSHOT_OVERLAY_HTML } from './overlay-html'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:snapshots-overlay')

interface OverlayCapture {
  id: string
  dataBase64: string
  bounds: SnapshotRectangle
}
interface ActiveOverlay {
  window: BrowserWindow
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

/** Native feedback stays above the source app without ever activating Ari. */
export class SnapshotOverlay {
  private active: ActiveOverlay | null = null

  show(capture: OverlayCapture, settings: Settings): void {
    this.dispose()
    if (!settings.snapshots.animation && !settings.snapshots.sound) return
    const displays = screen.getAllDisplays()
    const left = Math.min(...displays.map((display) => display.bounds.x))
    const top = Math.min(...displays.map((display) => display.bounds.y))
    const bounds = {
      x: left,
      y: top,
      width: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) - left,
      height:
        Math.max(...displays.map((display) => display.bounds.y + display.bounds.height)) - top,
    }
    const window = new BrowserWindow({
      ...bounds,
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
    const active: ActiveOverlay = {
      window,
      capture,
      settings,
      bounds,
      workArea: screen.getDisplayMatching(capture.bounds).workArea,
      attached: false,
      loaded: false,
      deadline: setTimeout(() => this.close(window), 5000),
    }
    this.active = active
    window.once('closed', () => {
      clearTimeout(active.deadline)
      if (this.active === active) this.active = null
    })
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SNAPSHOT_OVERLAY_HTML)}`)
      .then(async () => {
        if (this.active !== active || window.isDestroyed()) return
        active.loaded = true
        // showInactive and focusable:false preserve the foreground app and caret.
        if (settings.snapshots.animation) window.showInactive()
        if (active.attached) await window.webContents.executeJavaScript('window.snapshotAttached()')
        await window.webContents.executeJavaScript(
          `window.beginSnapshotFeedback(${JSON.stringify(this.presentation(active))})`,
        )
      })
      .catch((error: unknown) => log.warn('desktop feedback failed', { error: String(error) }))
      .finally(() => this.close(window))
  }

  destination(id: string, rectangle: SnapshotRectangle): void {
    const active = this.active
    if (!active || active.capture.id !== id) return
    active.destination = rectangle
    if (active.loaded) {
      const presentation = this.presentation(active)
      // The image is already decoded in the overlay; destination updates only
      // need geometry and animation frames, not another multi-MB payload.
      presentation.image = ''
      void active.window.webContents
        .executeJavaScript(`window.updateSnapshotDestination(${JSON.stringify(presentation)})`)
        .catch(() => undefined)
    }
  }

  acknowledge(id: string): void {
    const active = this.active
    if (!active || active.capture.id !== id) return
    active.attached = true
    if (active.loaded)
      void active.window.webContents
        .executeJavaScript('window.snapshotAttached()')
        .catch(() => undefined)
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
      image: `data:image/png;base64,${capture.dataBase64}`,
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

  private close(window: BrowserWindow): void {
    if (!window.isDestroyed()) window.destroy()
  }
  dispose(): void {
    if (this.active) this.close(this.active.window)
  }
}
