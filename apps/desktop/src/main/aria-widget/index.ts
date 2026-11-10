import { join } from 'node:path'
import { BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { defaultThemeId } from '@ari/ui/themes'
import type { Settings } from '@ari/contracts/settings'
import type { uIOhook } from 'uiohook-napi'
import { createLogger } from '@ari/shared/logger'
import { ChordTracker, defaultShortcut, parseChord, type HookKey } from './chord'
import { sendToAria } from './handoff'
import { HoldToTalk, type WidgetSnapshot } from './model'
import { widgetBounds } from './position'
import { defaultDictationShortcut, speechBindingsError } from '@ari/contracts/settings'
import { CaptureLease } from '../speech/capture-lease'
import { captureDictationTarget, prepareDictation } from '../speech/dictation-target'
import type { DictationTarget } from '../../shared/dictation'

const log = createLogger('desktop:aria-widget')
const METHODS = [
  'ariaWidget.ready',
  'ariaWidget.complete',
  'ariaWidget.error',
  'ariaWidget.settings',
  'ariaWidget.speech',
]

export interface AriaWidgetDeps {
  invoke(method: string, params?: unknown): Promise<unknown>
  openSettings(): void
  mainWindow?(): BrowserWindow | null
  captureTarget?(id: string): Promise<DictationTarget>
  prepareTarget?(): Promise<void>
}

type WidgetSettings = Settings

export class AriaWidget {
  private window: BrowserWindow | null = null
  private readonly hold = new HoldToTalk()
  private hook: typeof uIOhook | null = null
  private tracker: ChordTracker | null = null
  private dictationTracker: ChordTracker | null = null
  private readonly lease = new CaptureLease()
  private token: string | null = null
  private composerToken: string | null = null
  private target: Promise<DictationTarget> | null = null
  private targetReady = false
  private destination: 'aria' | 'dictation' = 'aria'
  private revision = 0
  private settings: WidgetSettings | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryDelay = 1_000
  private ready: (() => void) | null = null
  private boot: Promise<void> | null = null
  private sending: number | null = null
  private disposed = false
  private configuration = ''

  constructor(private readonly deps: AriaWidgetDeps) {
    for (const action of ['acquire', 'release']) {
      ipcMain.handle(`ari:speechCapture.${action}`, (event, token: unknown) => {
        if (event.sender !== this.deps.mainWindow?.()?.webContents || event.sender.isDestroyed())
          throw new Error('Rejected dictation sender')
        if (action === 'acquire') return (this.composerToken = this.lease.acquire())
        if (typeof token === 'string' && token === this.composerToken) {
          this.lease.release(token)
          this.composerToken = null
        }
        return undefined
      })
    }
    this.deps.mainWindow?.()?.webContents.on('render-process-gone', this.resetCapture)
    this.deps.mainWindow?.()?.webContents.on('did-start-navigation', this.resetCapture)
    for (const method of METHODS) {
      ipcMain.handle(`ari:${method}`, (event, params: unknown) => {
        if (event.sender !== this.window?.webContents || event.sender.isDestroyed())
          throw new Error('Rejected widget sender')
        return this.handle(method, params)
      })
    }
    powerMonitor.on('lock-screen', this.resetInput)
    powerMonitor.on('suspend', this.resetInput)
  }

  private readonly resetCapture = (): void => {
    this.lease.reset()
    this.composerToken = null
    this.hold.cancel()
    this.publish()
  }

  private releaseCapture(): void {
    if (this.token) this.lease.release(this.token)
    this.token = null
    const target = this.target
    this.target = null
    this.targetReady = false
    void target?.then(
      (target) => target.cancel(),
      () => undefined,
    )
  }

  private readonly resetInput = (): void => {
    this.tracker?.reset()
    this.dictationTracker?.reset()
    if (this.hold.active || (this.destination === 'dictation' && !this.hold.canStart)) {
      this.hold.cancel()
      this.publish()
    }
  }

  private scheduleDeadline(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!Number.isFinite(this.hold.expiresAt) || this.disposed) return
    const now = performance.now()
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.hold.tick(performance.now())
        this.publish()
      },
      Math.max(0, this.hold.expiresAt - now),
    )
    this.timer.unref()
  }

  private recoverWindow(): void {
    this.destroyWindow()
    const speech = this.settings?.speech
    if (this.disposed || !speech?.enabled || this.recoveryTimer) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      if (this.settings) void this.configure(this.settings)
    }, this.recoveryDelay)
    this.recoveryDelay = Math.min(30_000, this.recoveryDelay * 2)
    this.recoveryTimer.unref()
  }

  private snapshot(): WidgetSnapshot {
    const appearance = this.settings?.appearance
    return {
      ...this.hold.state,
      theme: appearance?.themeId ?? defaultThemeId,
      reducedMotion: appearance?.reducedMotion ?? false,
      destination: this.destination,
    }
  }

  private publish(): void {
    if (this.hold.canStart) this.releaseCapture()
    this.scheduleDeadline()
    const win = this.window
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('ari:ariaWidget.state', this.snapshot())
    if (!this.hold.visible()) win.hide()
    else {
      win.setBounds(
        widgetBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
      )
      if (!win.isVisible()) win.showInactive()
    }
  }

  private createWindow(): Promise<void> {
    if (this.boot) return this.boot
    const boot = new Promise<void>((resolve) => {
      this.ready = resolve
    })
    const ready = this.ready!
    this.boot = boot
    const win = new BrowserWindow({
      ...widgetBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      type: process.platform === 'darwin' ? 'panel' : 'toolbar',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/widget.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    this.window = win
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('will-redirect', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', () => {
      if (this.window === win) this.recoverWindow()
    })
    win.once('closed', () => {
      ready()
      if (this.window !== win) return
      this.window = null
      this.ready = null
      this.boot = null
    })
    const url = process.env['ELECTRON_RENDERER_URL']
    const loaded = url
      ? win.loadURL(new URL('widget/index.html', url).href)
      : win.loadFile(join(import.meta.dirname, '../renderer/widget/index.html'))
    void loaded.catch((error: unknown) => {
      if (this.window !== win) return
      log.warn('widget failed to load', { error: String(error) })
      this.recoverWindow()
    })
    return boot
  }

  async configure(settings: Settings): Promise<void> {
    this.settings = settings
    this.publish()
    const speech = this.settings.speech
    const configuration = JSON.stringify(speech) ?? ''
    if (configuration === this.configuration && (this.hook || this.recoveryTimer)) return
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.configuration = configuration
    const revision = ++this.revision
    this.stopHook()
    if (!speech?.enabled || this.disposed) return
    try {
      const status = (await this.deps.invoke('speech.status')) as { ready: boolean }
      if (revision !== this.revision || this.disposed) return
      if (!status.ready) {
        // Speech can become ready without a status frame reaching us (engine
        // checks at boot), so look again rather than stay unarmed all session.
        this.readyTimer = setTimeout(() => {
          this.readyTimer = null
          if (this.settings && revision === this.revision) {
            this.configuration = ''
            void this.configure(this.settings)
          }
        }, 30_000)
        this.readyTimer.unref()
        return
      }
      const { uIOhook, UiohookKey } = await import('uiohook-napi')
      if (revision !== this.revision || this.disposed) return
      const shortcut = speech.shortcut || defaultShortcut(process.platform)
      const dictationShortcut =
        speech.dictationShortcut || defaultDictationShortcut(process.platform)
      const invalid = speechBindingsError(shortcut, dictationShortcut, process.platform)
      if (invalid) throw new Error(invalid)
      const chord = parseChord(shortcut, UiohookKey, process.platform)
      const dictationChord = parseChord(dictationShortcut, UiohookKey, process.platform)
      if (!chord || !dictationChord) throw new Error('Invalid speech shortcut')
      // External support failing must not disable Aria or in-app dictation.
      await (this.deps.prepareTarget ?? prepareDictation)().catch((error) =>
        log.warn('external dictation unavailable', { error: String(error) }),
      )
      await this.createWindow()
      if (revision !== this.revision || this.disposed || !this.window) return
      this.tracker = new ChordTracker(chord, UiohookKey.Escape)
      this.dictationTracker = new ChordTracker(dictationChord, UiohookKey.Escape)
      this.hook = uIOhook
      uIOhook.on('keydown', this.keyDown)
      uIOhook.on('keyup', this.keyUp)
      uIOhook.start()
    } catch (error) {
      this.stopHook()
      log.warn('speech shortcut unavailable', { error: String(error) })
    }
  }

  private readonly keyDown = (event: HookKey): void => {
    const now = performance.now()
    const canStart = this.hold.canStart && !this.lease.busy
    const ariaAction = this.tracker?.down(event, now, canStart)
    const dictationAction = this.dictationTracker?.down(event, now, canStart)
    const action =
      event.keycode === 1 && this.destination === 'dictation' && !this.hold.canStart
        ? 'cancel'
        : this.hold.canStart
          ? (ariaAction ?? dictationAction)
          : this.destination === 'aria'
            ? ariaAction
            : dictationAction
    if (action === 'down') {
      if (!this.hold.down(now)) return
      this.token = this.lease.acquire()
      this.destination = ariaAction === 'down' ? 'aria' : 'dictation'
      this.recoveryDelay = 1_000
      if (this.destination === 'dictation') {
        const id = this.hold.state.id
        const token = this.token
        // Start target capture before displaying the recording pill.
        try {
          this.target = (
            this.deps.captureTarget ??
            ((id: string) => captureDictationTarget(this.deps.mainWindow?.() ?? null, id))
          )(token)
        } catch (error) {
          this.target = Promise.reject(error instanceof Error ? error : new Error(String(error)))
        }
        void this.target.then(
          () => {
            if (this.lease.current(token)) {
              this.targetReady = true
              this.publish()
            }
          },
          (error) => {
            if (!this.lease.current(token)) return
            this.hold.error(
              id,
              error instanceof Error ? error.message : 'No dictation target.',
              false,
              performance.now(),
            )
            this.publish()
          },
        )
        return
      }
    } else if (action === 'cancel' && !this.hold.canStart) this.hold.cancel()
    else if (action === 'up' && this.hold.active) {
      if (this.destination === 'dictation' && !this.targetReady) this.hold.cancel()
      else this.hold.up(now)
    } else return
    this.publish()
  }

  private readonly keyUp = (event: HookKey): void => {
    const ariaAction = this.tracker?.up(event)
    const dictationAction = this.dictationTracker?.up(event)
    if ((this.destination === 'aria' ? ariaAction : dictationAction) !== 'up' || !this.hold.active)
      return
    if (this.destination === 'dictation' && !this.targetReady) this.hold.cancel()
    else this.hold.up(performance.now())
    this.publish()
  }

  private async handle(method: string, raw: unknown): Promise<unknown> {
    if (method === 'ariaWidget.speech') {
      const params = raw as { method?: unknown; payload?: unknown } | null
      // Keep the auxiliary renderer out of the application's privileged RPC surface.
      if (params?.method !== 'speech.status' && params?.method !== 'speech.transcribe')
        throw new Error('Rejected widget method')
      return this.deps.invoke(params.method, params.payload)
    }
    if (method === 'ariaWidget.ready') {
      this.ready?.()
      this.ready = null
      return this.snapshot()
    }
    if (method === 'ariaWidget.settings') {
      if (this.hold.state.setup) this.deps.openSettings()
      this.hold.cancel()
      this.publish()
      return undefined
    }
    const params = raw as { id?: unknown; text?: unknown; setup?: unknown } | null
    if (!params || typeof params.id !== 'number' || typeof params.text !== 'string')
      throw new Error('Invalid widget result')
    if (method === 'ariaWidget.error') {
      this.hold.error(
        params.id,
        params.text.slice(0, 180),
        params.setup === true,
        performance.now(),
      )
    } else if (
      params.id === this.hold.state.id &&
      this.hold.state.phase === 'transcribing' &&
      this.sending !== params.id
    ) {
      const id = params.id
      const text = params.text.trim()
      this.sending = id
      try {
        if (text) {
          if (this.destination === 'dictation') {
            const token = this.token
            const target = await this.target
            if (!token || !target || !this.lease.current(token)) return
            await target.insert(
              text,
              () =>
                this.lease.current(token) &&
                id === this.hold.state.id &&
                this.hold.state.phase === 'transcribing' &&
                !this.disposed,
            )
          } else
            await sendToAria(
              {
                current: () =>
                  id === this.hold.state.id &&
                  this.hold.state.phase === 'transcribing' &&
                  !this.disposed,
                open: async () => (await this.deps.invoke('aria.open')) as { sessionId: string },
                dispatch: async (command) =>
                  (await this.deps.invoke('command.dispatch', { command })) as {
                    accepted: boolean
                    reason?: string
                  },
              },
              text,
            )
        }
        this.hold.finish(id, text, performance.now())
      } catch (error) {
        this.hold.error(
          id,
          error instanceof Error ? error.message : 'Could not complete dictation.',
          false,
          performance.now(),
        )
      } finally {
        this.sending = null
      }
    }
    this.publish()
    return undefined
  }

  private stopHook(): void {
    this.hook?.removeListener('keydown', this.keyDown)
    this.hook?.removeListener('keyup', this.keyUp)
    this.hook?.stop()
    this.hook = null
    this.tracker = null
    this.dictationTracker = null
    this.hold.cancel()
    this.publish()
  }

  destroyWindow(): void {
    const window = this.window
    this.window = null
    this.ready?.()
    this.ready = null
    this.boot = null
    this.stopHook()
    window?.destroy()
  }

  close(): void {
    this.disposed = true
    ++this.revision
    if (this.timer) clearTimeout(this.timer)
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    powerMonitor.removeListener('lock-screen', this.resetInput)
    powerMonitor.removeListener('suspend', this.resetInput)
    this.deps.mainWindow?.()?.webContents.removeListener('render-process-gone', this.resetCapture)
    this.deps.mainWindow?.()?.webContents.removeListener('did-start-navigation', this.resetCapture)
    this.lease.reset()
    this.destroyWindow()
    for (const method of METHODS) ipcMain.removeHandler(`ari:${method}`)
    for (const action of ['acquire', 'release'])
      ipcMain.removeHandler(`ari:speechCapture.${action}`)
  }
}
