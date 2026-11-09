import { afterFirstPaint } from '../startup-gate'

interface ReopenableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  once(event: 'ready-to-show', callback: () => void): unknown
}

/** Every entry point that recreates the main window must also bind its services. */
export class MainWindowLifecycle<W extends ReopenableWindow> {
  private window: W | null = null
  private painted = false
  private showRequested = false
  constructor(
    private readonly create: () => W,
    private readonly bind: (window: W) => void,
  ) {}

  ensure(): W {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.create()
      this.painted = false
      this.showRequested = false
      const window = this.window
      void afterFirstPaint(window, 0).then(() => {
        if (this.window !== window || window.isDestroyed()) return
        this.painted = true
        if (this.showRequested) this.show()
      })
      this.bind(this.window)
    }
    return this.window
  }

  show(): void {
    const window = this.ensure()
    if (!this.painted) {
      this.showRequested = true
      return
    }
    this.showRequested = false
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
