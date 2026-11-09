interface ReopenableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/** Every entry point that recreates the main window must also bind its services. */
export class MainWindowLifecycle<W extends ReopenableWindow> {
  private window: W | null = null
  constructor(
    private readonly create: () => W,
    private readonly bind: (window: W) => void,
  ) {}

  ensure(): W {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.create()
      this.bind(this.window)
    }
    return this.window
  }

  show(): void {
    const window = this.ensure()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
