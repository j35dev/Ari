import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, globalShortcut, ipcMain, type WebContents } from 'electron'
import {
  snapshotShortcutError,
  defaultSnapshotShortcut,
  type Settings,
} from '@ari/contracts/settings'
import type { SettingsStore, SettingsPatch } from '@ari/engine/settings'
import { MAX_ATTACHMENT_BYTES } from '@ari/contracts/attachments'
import type { SnapshotEvent, SnapshotStatus } from '../../shared/snapshots'
import { snapshotRectangleSchema, type SnapshotRectangle } from '../../shared/snapshots'
import { createLogger } from '@ari/shared/logger'
import type { AttachmentStore } from '../attachments'
import { isTrustedIpcSender } from '../ipc-methods'
import { captureForegroundWindow } from './capture'
import { PendingSnapshots } from './pending-store'
import { SnapshotShortcut } from './shortcut'
import { SnapshotOverlay, containsPoint } from './overlay'

const log = createLogger('desktop:snapshots')

export class SnapshotsService {
  private readonly pending: PendingSnapshots
  private readonly shortcut = new SnapshotShortcut(globalShortcut, () => {
    void this.capture()
  })
  private busy = false
  private disposed = false
  private error: string | null = null
  private settings: Settings | null = null
  private updates: Promise<unknown> = Promise.resolve()
  private readonly overlay = new SnapshotOverlay()
  private source: { id: string; bounds: SnapshotRectangle } | null = null

  constructor(
    private readonly contents: WebContents,
    dir: string,
    private readonly attachments: AttachmentStore,
  ) {
    this.pending = new PendingSnapshots(join(dir, 'snapshots', 'pending'))
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      status: () => this.status(),
      pending: () => this.pending.list(),
      read: async (id) => {
        const item = await this.pending.read(String(id))
        const image = await this.attachments.read(item.attachment.id)
        if (!image)
          throw new Error(
            'The captured image could not be read. The pending capture has been preserved.',
          )
        return { ...item, dataBase64: image.dataBase64 }
      },
      target: async (id, target) => {
        if (typeof target !== 'string' || !target || target.length > 128)
          throw new Error('Invalid capture destination')
        const item = await this.pending.read(String(id))
        // The renderer keeps a live pin and only sends another when it is gone.
        if (item.target !== target) await this.pending.save({ ...item, target })
        return target
      },
      acknowledge: async (id) => {
        await this.pending.acknowledge(String(id))
        this.overlay.acknowledge(String(id))
      },
      destination: (id, rectangle) => {
        const source = this.source
        if (!source || source.id !== id) return
        const viewport = snapshotRectangleSchema.parse(rectangle)
        const window = BrowserWindow.fromWebContents(contents)
        if (!window?.isVisible() || window.isMinimized()) return
        const content = window.getContentBounds()
        if (
          viewport.x < 0 ||
          viewport.y < 0 ||
          viewport.x + viewport.width > content.width ||
          viewport.y + viewport.height > content.height
        )
          return
        const destination = { ...viewport, x: content.x + viewport.x, y: content.y + viewport.y }
        // If the source app covers this point, the composer is not visible.
        // Keep the receipt on the source screen instead of raising Ari.
        if (
          !window.isFocused() &&
          containsPoint(
            source.bounds,
            destination.x + destination.width / 2,
            destination.y + destination.height / 2,
          )
        )
          return
        this.overlay.destination(String(id), destination)
      },
      suppress: (suppressed) => {
        if (typeof suppressed !== 'boolean') throw new Error('Invalid shortcut state')
        this.shortcut.configure(
          suppressed
            ? null
            : this.settings?.snapshots.enabled
              ? this.settings.snapshots.shortcut
              : null,
        )
      },
    }
    for (const [method, handler] of Object.entries(handlers)) {
      ipcMain.handle(`ari:snapshots.${method}`, (event, ...args: unknown[]) => {
        if (!isTrustedIpcSender(event.sender, contents) || event.senderFrame !== contents.mainFrame)
          throw new Error('Untrusted SnapShots request')
        return handler(...args)
      })
    }
    contents.once('destroyed', () => this.dispose())
  }

  status(): SnapshotStatus {
    return {
      supported: process.platform === 'win32',
      registered: this.shortcut.registered,
      error: this.error,
    }
  }

  configure(settings: Settings): void {
    if (this.disposed) return
    if (settings.snapshots.enabled && process.platform !== 'win32')
      throw new Error('SnapShots currently supports Windows.')
    const shortcut = settings.snapshots.shortcut || defaultSnapshotShortcut(process.platform)
    const invalid = snapshotShortcutError(shortcut, process.platform, settings.speech)
    if (settings.snapshots.enabled && invalid) throw new Error(invalid)
    this.shortcut.configure(settings.snapshots.enabled ? shortcut : null)
    this.settings = { ...settings, snapshots: { ...settings.snapshots, shortcut } }
    this.error = null
  }

  initialize(settings: Settings): void {
    try {
      this.configure(settings)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  /** OS registration must succeed before enabled/shortcut preferences are committed. */
  updateSettings(store: SettingsStore, patch: SettingsPatch): Promise<Settings> {
    const task = this.updates.then(async () => {
      const previous = store.current
      // Only bindings can collide; other speech saves must not retry registration.
      const changesShortcut =
        patch.snapshots !== undefined ||
        patch.speech?.shortcut !== undefined ||
        patch.speech?.dictationShortcut !== undefined
      if (changesShortcut)
        this.configure({
          ...previous,
          snapshots: { ...previous.snapshots, ...patch.snapshots },
          speech: { ...previous.speech, ...patch.speech },
        })
      try {
        const next = await store.update(patch)
        // Feedback reads appearance too, e.g. Reduce motion; keep the copy current.
        if (!this.disposed)
          this.settings = {
            ...next,
            snapshots: {
              ...next.snapshots,
              shortcut: next.snapshots.shortcut || defaultSnapshotShortcut(process.platform),
            },
          }
        return next
      } catch (error) {
        if (changesShortcut) this.initialize(previous)
        throw error
      }
    })
    this.updates = task.catch(() => undefined)
    return task
  }

  private publish(event: SnapshotEvent): void {
    if (!this.contents.isDestroyed()) this.contents.send('ari:snapshots.event', event)
  }

  private async capture(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      this.overlay.dispose()
      const captured = await captureForegroundWindow()
      if ((await this.pending.list()).length >= 20)
        throw new Error('Attach your pending captures before taking more SnapShots.')
      if (!captured.bytes.length || captured.bytes.length > MAX_ATTACHMENT_BYTES)
        throw new Error('This captured window is too large to attach. Try a smaller window.')
      const title = Array.from(captured.windowTitle.replace(/[\\/:*?"<>|]/g, ''))
        .filter((character) => character.charCodeAt(0) >= 32)
        .join('')
      const name = `SnapShot ${title.slice(0, 80) || 'window'}.png`
      const [attachment] = await this.attachments.stage([
        { name, mimeType: 'image/png', dataBase64: captured.bytes.toString('base64') },
      ])
      if (!attachment) throw new Error('The capture could not be saved.')
      const id = randomUUID()
      await this.pending.save({
        id,
        capturedAt: Date.now(),
        attachment,
        windowTitle: captured.windowTitle,
        desktopFeedback: true,
      })
      this.source = { id, bounds: captured.bounds }
      try {
        if (this.settings && !this.disposed)
          this.overlay.show(
            { id, dataBase64: captured.bytes.toString('base64'), bounds: captured.bounds },
            this.settings,
          )
      } catch (error) {
        log.warn('capture saved; desktop feedback unavailable', { error: String(error) })
      }
      this.publish({ type: 'captured' })
    } catch (error) {
      this.publish({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.shortcut.dispose()
    this.overlay.dispose()
    for (const method of [
      'status',
      'pending',
      'read',
      'target',
      'acknowledge',
      'destination',
      'suppress',
    ])
      ipcMain.removeHandler(`ari:snapshots.${method}`)
  }
}
