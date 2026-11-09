import { join } from 'node:path'
import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron'
import type { Settings } from '@ari/contracts/settings'
import type { SessionReadModel } from '@ari/engine/projection'
import type { uIOhook } from 'uiohook-napi'
import { createLogger } from '@ari/shared/logger'
import { ChordTracker, defaultShortcut, parseChord, type HookKey } from './chord'
import { sendToAria } from './handoff'
import { HoldToTalk, type WidgetSnapshot } from './model'
import { widgetBounds } from './position'

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
}

export class AriaWidget {
  private window: BrowserWindow | null = null
  private readonly hold = new HoldToTalk()
  private hook: typeof uIOhook | null = null
  private tracker: ChordTracker | null = null
  private revision = 0
  private settings: Settings | null = null
  private timer: ReturnType<typeof setInterval>
  private ready: (() => void) | null = null
  private boot: Promise<void> | null = null
  private sending: number | null = null
  private disposed = false
  private configuration = ''

  constructor(private readonly deps: AriaWidgetDeps) {
    for (const method of METHODS) {
      ipcMain.handle(`ari:${method}`, (event, params: unknown) => {
        if (event.sender !== this.window?.webContents || event.sender.isDestroyed())
          throw new Error('Rejected widget sender')
        return this.handle(method, params)
      })
    }
    this.timer = setInterval(() => {
      const before = this.hold.state
      this.hold.tick(Date.now())
      if (before !== this.hold.state) this.publish()
    }, 100)
    this.timer.unref()
    nativeTheme.on('updated', this.themeChanged)
  }

  private readonly themeChanged = (): void => this.publish()

  private snapshot(): WidgetSnapshot {
    const appearance = this.settings?.appearance
    return {
      ...this.hold.state,
      theme:
        appearance?.mode === 'system'
          ? nativeTheme.shouldUseDarkColors
            ? 'obsidian'
            : 'porcelain'
          : (appearance?.themeId ?? 'obsidian'),
      reducedMotion: appearance?.reducedMotion ?? false,
    }
  }

  private publish(): void {
    const win = this.window
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('ari:ariaWidget.state', this.snapshot())
    if (this.hold.state.phase === 'hidden') win.hide()
    else {
      win.setBounds(
        widgetBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea),
      )
      if (!win.isVisible()) win.showInactive()
    }
  }

  private createWindow(): Promise<void> {
    if (this.boot) return this.boot
    this.boot = new Promise((resolve) => {
      this.ready = resolve
    })
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
      this.stopHook()
      this.destroyWindow()
    })
    win.once('closed', () => {
      if (this.window === win) this.window = null
      this.ready?.()
      this.ready = null
      this.boot = null
    })
    const url = process.env['ELECTRON_RENDERER_URL']
    const loaded = url
      ? win.loadURL(new URL('widget/index.html', url).href)
      : win.loadFile(join(import.meta.dirname, '../renderer/widget/index.html'))
    void loaded.catch((error: unknown) => {
      log.warn('widget failed to load', { error: String(error) })
      this.destroyWindow()
    })
    return this.boot
  }

  async configure(settings: Settings): Promise<void> {
    this.settings = settings
    this.publish()
    // Optional until the concurrently-built speech settings contract is merged.
    const speech = (settings as Settings & { speech?: { enabled: boolean; shortcut: string } })
      .speech
    const configuration = JSON.stringify(speech) ?? ''
    if (configuration === this.configuration && this.hook) return
    this.configuration = configuration
    const revision = ++this.revision
    this.stopHook()
    if (!speech?.enabled || this.disposed) return
    try {
      const status = (await this.deps.invoke('speech.status')) as { ready: boolean }
      if (revision !== this.revision || this.disposed || !status.ready) return
      const { uIOhook, UiohookKey } = await import('uiohook-napi')
      if (revision !== this.revision || this.disposed) return
      const chord = parseChord(
        speech.shortcut || defaultShortcut(process.platform),
        UiohookKey,
        process.platform,
      )
      if (!chord) throw new Error('Invalid speech shortcut')
      await this.createWindow()
      if (revision !== this.revision || this.disposed || !this.window) return
      this.tracker = new ChordTracker(chord, UiohookKey.Escape)
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
    const action = this.tracker?.down(event)
    if (action === 'down') this.hold.down(Date.now())
    else if (action === 'cancel') this.hold.cancel()
    else return
    this.publish()
  }

  private readonly keyUp = (event: HookKey): void => {
    if (this.tracker?.up(event) !== 'up') return
    this.hold.up(Date.now())
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
      this.hold.error(params.id, params.text.slice(0, 180), params.setup === true, Date.now())
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
          await sendToAria(
            {
              current: () =>
                id === this.hold.state.id &&
                this.hold.state.phase === 'transcribing' &&
                !this.disposed,
              open: async () => (await this.deps.invoke('aria.open')) as { sessionId: string },
              load: async (sessionId) =>
                (await this.deps.invoke('session.load', { sessionId })) as SessionReadModel | null,
              dispatch: async (command) =>
                (await this.deps.invoke('command.dispatch', { command })) as {
                  accepted: boolean
                  reason?: string
                },
            },
            text,
          )
        }
        this.hold.finish(id, text, Date.now())
      } catch (error) {
        this.hold.error(
          id,
          error instanceof Error ? error.message : 'Could not send to Aria.',
          false,
          Date.now(),
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
    this.hold.cancel()
    this.publish()
  }

  destroyWindow(): void {
    this.stopHook()
    this.window?.destroy()
  }

  close(): void {
    this.disposed = true
    ++this.revision
    clearInterval(this.timer)
    nativeTheme.removeListener('updated', this.themeChanged)
    this.destroyWindow()
    for (const method of METHODS) ipcMain.removeHandler(`ari:${method}`)
  }
}
