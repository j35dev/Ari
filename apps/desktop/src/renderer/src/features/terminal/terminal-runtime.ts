import { useSyncExternalStore } from 'react'
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { rpc } from '../../lib/rpc'
import { codeFonts } from '../../lib/appearance'
import { bindTerminalClipboard } from './terminal-clipboard'
import { findTerminalTab, subscribeTerminalDock } from './terminal-dock'
import { subscribeTerminalPreferences, terminalPreferences } from './terminal-preferences'
import type { TerminalDataFrame } from '@ari/contracts/rpc'

export interface TerminalStatus {
  state: 'connecting' | 'running' | 'exited' | 'missing' | 'error'
  title: string | null
  cwd: string | null
  cols: number
  rows: number
  exitCode: number | null
  error: string | null
  scrolledUp: boolean
}
const EMPTY_STATUS: TerminalStatus = {
  state: 'connecting',
  title: null,
  cwd: null,
  cols: 0,
  rows: 0,
  exitCode: null,
  error: null,
  scrolledUp: false,
}
const runtimes = new Map<string, TerminalRuntime>()
const statusListeners = new Set<() => void>()
const FALLBACK_FONT = "'Cascadia Code', ui-monospace, monospace"
const FONTS = {
  cascadia: codeFonts.find((font) => font.id === 'cascadia')!.family,
  jetbrains: codeFonts.find((font) => font.id === 'jetbrains-mono')!.family,
  geist: codeFonts.find((font) => font.id === 'geist-mono')!.family,
}

function token(name: string, fallback: string, source = document.documentElement): string {
  const local = getComputedStyle(source.isConnected ? source : document.documentElement)
    .getPropertyValue(name)
    .trim()
  return (
    local || getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  )
}

/** All sixteen ANSI slots follow the active Ari palette, including live custom themes. */
export function terminalTheme(source = document.documentElement): ITheme {
  const color = (name: string, role: string, fallback: string): string =>
    token(`--ari-terminal-${name}`, token(`--ari-${role}`, fallback, source), source)
  const part = source.closest<HTMLElement>('[data-ari-part="terminal"]')
  const partStyle = part ? getComputedStyle(part) : null
  const background = partStyle?.backgroundColor
  return {
    background:
      background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)'
        ? background
        : color('background', 'bg', '#0b0b0e'),
    foreground: partStyle?.color || color('foreground', 'fg', '#e6e6ea'),
    cursor: color('cursor', 'accent', '#7c6cf0'),
    cursorAccent: color('cursor-accent', 'bg', '#0b0b0e'),
    selectionBackground: color('selection', 'accent-subtle', '#333333'),
    black: color('black', 'surface-2', '#27272a'),
    red: color('red', 'danger', '#f87171'),
    green: color('green', 'success', '#4ade80'),
    yellow: color('yellow', 'warning', '#facc15'),
    blue: color('blue', 'info', '#60a5fa'),
    magenta: color('magenta', 'accent', '#a78bfa'),
    cyan: color('cyan', 'info', '#67e8f9'),
    white: color('white', 'fg-muted', '#d4d4d8'),
    brightBlack: color('bright-black', 'fg-subtle', '#71717a'),
    brightRed: color('bright-red', 'danger', '#fca5a5'),
    brightGreen: color('bright-green', 'success', '#86efac'),
    brightYellow: color('bright-yellow', 'warning', '#fde68a'),
    brightBlue: color('bright-blue', 'info', '#93c5fd'),
    brightMagenta: color('bright-magenta', 'accent', '#c4b5fd'),
    brightCyan: color('bright-cyan', 'info', '#a5f3fc'),
    brightWhite: color('bright-white', 'fg', '#fafafa'),
  }
}

export function terminalOptions(source = document.documentElement): ITerminalOptions {
  const prefs = terminalPreferences()
  const themeSize = Number(token('--ari-terminal-font-size', String(prefs.fontSize), source))
  return {
    fontFamily:
      prefs.font === 'theme' ? token('--ari-font-mono', FALLBACK_FONT, source) : FONTS[prefs.font],
    fontSize: Number.isFinite(themeSize) ? Math.max(11, Math.min(24, themeSize)) : prefs.fontSize,
    lineHeight: prefs.lineHeight,
    fontWeight: 400,
    fontWeightBold: 600,
    cursorStyle: prefs.cursor,
    cursorBlink: true,
    scrollback: prefs.scrollback,
    minimumContrastRatio: 1.5,
    allowProposedApi: true,
    theme: terminalTheme(source),
  }
}

function emit(): void {
  for (const listener of statusListeners) listener()
}
function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}
export function terminalStatus(id: string): TerminalStatus {
  return runtimes.get(id)?.status ?? EMPTY_STATUS
}
export function useTerminalStatus(id: string): TerminalStatus {
  return useSyncExternalStore(subscribeStatus, () => terminalStatus(id))
}

/** A local terminal outlives React pane frames; moving its DOM never reconstructs its VT state. */
export class TerminalRuntime {
  readonly terminal: Terminal
  readonly element: HTMLDivElement
  readonly fit = new FitAddon()
  readonly search = new SearchAddon()
  status: TerminalStatus
  readonly #disposers: (() => void)[] = []
  #mount: HTMLElement | null = null
  #observer: ResizeObserver | null = null
  #resizeFrame: number | null = null
  #destroyed = false
  #started = false
  #errorListeners = new Set<(message: string) => void>()

  constructor(
    readonly id: string,
    cwd: string | null,
  ) {
    this.status = { ...EMPTY_STATUS, cwd }
    this.element = document.createElement('div')
    this.element.className = 'ari-terminal-runtime'
    this.terminal = new Terminal(terminalOptions())
    this.terminal.loadAddon(this.fit)
    this.terminal.loadAddon(this.search)
    this.terminal.loadAddon(
      new WebLinksAddon((_event, url) => {
        void rpc.invoke('shell.openUrl', { url }).catch(() => undefined)
      }),
    )
    this.terminal.open(this.element)
    const scroll = this.terminal.onScroll(() => this.syncScrollPosition())
    const parsed = this.terminal.onWriteParsed(() => this.syncScrollPosition())
    const resized = this.terminal.onResize(() => this.syncScrollPosition())
    this.#disposers.push(
      () => scroll.dispose(),
      () => parsed.dispose(),
      () => resized.dispose(),
    )
    this.#disposers.push(
      bindTerminalClipboard(this.terminal, (message) => this.terminal.writeln(`\r\n[${message}]`)),
    )
    const data = rpc.subscribe('terminal.data', { id }, (payload) => {
      const frame = payload as TerminalDataFrame
      if (frame.id !== id || this.#destroyed) return
      if (frame.data) {
        this.terminal.write(frame.data)
        if (this.status.state === 'connecting' || this.status.state === 'missing')
          this.update({ state: 'running', error: null })
      }
      if (frame.exited) {
        this.terminal.options.disableStdin = true
        this.update({ state: 'exited', exitCode: frame.exitCode ?? null })
      }
    })
    const input = this.terminal.onData((data) => {
      void rpc
        .invoke('terminal.write', { id, data })
        .catch((error: unknown) => this.fail(String(error)))
    })
    this.#disposers.push(data, () => input.dispose())
    if (this.terminal.onTitleChange) {
      const title = this.terminal.onTitleChange((value) =>
        this.update({ title: value.slice(0, 500) || null }),
      )
      this.#disposers.push(() => title.dispose())
    }
    if (this.terminal.parser?.registerOscHandler) {
      const cwd = this.terminal.parser.registerOscHandler(7, (value) => {
        try {
          const uri = new URL(value)
          if (uri.protocol !== 'file:') return false
          let path = decodeURIComponent(uri.pathname)
          if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replaceAll('/', '\\')
          this.update({ cwd: path })
          return true
        } catch {
          return false
        }
      })
      this.#disposers.push(() => cwd.dispose())
    }
    const themeObserver = new MutationObserver(() => this.applyOptions())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'style',
        'data-ari-theme',
        'data-ari-custom-theme',
        'data-ari-workspace-view',
      ],
    })
    this.#disposers.push(
      () => themeObserver.disconnect(),
      subscribeTerminalPreferences(() => this.applyOptions()),
    )
    this.warmFont()
  }

  update(next: Partial<TerminalStatus>): void {
    if (
      Object.entries(next).every(
        ([key, value]) => this.status[key as keyof TerminalStatus] === value,
      )
    )
      return
    this.status = { ...this.status, ...next }
    emit()
  }

  private syncScrollPosition(): void {
    if (this.#destroyed) return
    const buffer = this.terminal.buffer.active
    this.update({
      scrolledUp: buffer.type === 'normal' && buffer.viewportY < buffer.baseY,
    })
  }

  fail(message: string): void {
    if (this.#destroyed) return
    this.update({ state: 'error', error: message })
    this.terminal.writeln(`\r\n[${message}]`)
    for (const listener of this.#errorListeners) listener(message)
  }

  onError(listener: (message: string) => void): () => void {
    this.#errorListeners.add(listener)
    if (this.status.error) listener(this.status.error)
    return () => this.#errorListeners.delete(listener)
  }

  start(cwd: string, initialCommand?: string, attachOnly = false): void {
    if (this.#started) return
    this.#started = true
    if (attachOnly) {
      void this.refreshInfo()
      return
    }
    void rpc
      .invoke('terminal.create', {
        id: this.id,
        cwd,
        ...(initialCommand ? { initialCommand } : {}),
        ...(this.status.cols >= 2 && this.status.rows >= 2
          ? { cols: this.status.cols, rows: this.status.rows }
          : {}),
      })
      .then(() => this.refreshInfo())
      .catch((error: unknown) => {
        // Retry is explicit. A React mount never becomes a second launch attempt.
        this.terminal.options.disableStdin = true
        this.fail(error instanceof Error ? error.message : String(error))
      })
  }

  async refreshInfo(): Promise<void> {
    try {
      const info = await rpc.invoke('terminal.info', { id: this.id })
      if (this.#destroyed || info === undefined) return
      this.terminal.options.disableStdin = info === null || info.exited
      this.update(
        info
          ? {
              state: info.exited ? 'exited' : 'running',
              cwd: info.cwd,
              exitCode: info.exitCode,
            }
          : { state: 'missing', error: null },
      )
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  mount(host: HTMLElement): () => void {
    this.#observer?.disconnect()
    this.#mount = host
    host.append(this.element)
    this.applyOptions()
    this.#observer = new ResizeObserver(() => this.scheduleFit())
    this.#observer.observe(host)
    this.fitNow()
    this.scheduleFit()
    return () => {
      if (this.#mount !== host) return
      this.#observer?.disconnect()
      this.#observer = null
      this.#mount = null
      // Keep the xterm, its buffer and one stream connection until explicitly stopped.
      this.element.remove()
      if (!findTerminalTab(this.id))
        queueMicrotask(() => {
          if (!this.#mount && !findTerminalTab(this.id)) destroyTerminalRuntime(this.id)
        })
    }
  }

  focus(): void {
    this.terminal.focus()
  }
  scheduleFit(): void {
    if (this.#destroyed || this.#resizeFrame !== null) return
    this.#resizeFrame = requestAnimationFrame(() => {
      this.#resizeFrame = null
      this.fitNow()
    })
  }

  fitNow(): void {
    const host = this.#mount
    if (
      !host?.isConnected ||
      host.getBoundingClientRect().width < 2 ||
      host.getBoundingClientRect().height < 2
    )
      return
    try {
      this.fit.fit()
      const { cols, rows } = this.terminal
      if (cols < 2 || rows < 2 || (cols === this.status.cols && rows === this.status.rows)) return
      this.update({ cols, rows })
      void rpc.invoke('terminal.resize', { id: this.id, cols, rows }).catch(() => undefined)
    } catch {
      /* hidden panes keep their last valid PTY dimensions */
    }
  }

  applyOptions(): void {
    if (this.#destroyed) return
    const options = terminalOptions(this.element)
    for (const [key, value] of Object.entries(options))
      (this.terminal.options as Record<string, unknown>)[key] = value
    this.scheduleFit()
    this.warmFont()
  }

  warmFont(): void {
    const { fontFamily, fontSize } = this.terminal.options
    try {
      void document.fonts
        .load(`${fontSize}px ${fontFamily}`)
        .then(() => {
          if (
            this.#destroyed ||
            this.terminal.options.fontFamily !== fontFamily ||
            this.terminal.options.fontSize !== fontSize ||
            fontFamily === FALLBACK_FONT
          )
            return
          this.terminal.options.fontFamily = FALLBACK_FONT
          this.terminal.options.fontFamily = fontFamily
          this.scheduleFit()
        })
        .catch(() => undefined)
    } catch {
      /* jsdom has no FontFaceSet */
    }
  }

  find(query: string, previous = false): boolean {
    if (!query) {
      this.search.clearDecorations()
      return false
    }
    return previous ? this.search.findPrevious(query) : this.search.findNext(query)
  }
  clearSearch(): void {
    this.search.clearDecorations()
  }
  clear(): void {
    this.terminal.clear()
    this.focus()
  }
  scrollToBottom(): void {
    this.terminal.scrollToBottom()
  }

  dispose(): void {
    this.#destroyed = true
    if (this.#resizeFrame !== null) cancelAnimationFrame(this.#resizeFrame)
    this.#observer?.disconnect()
    for (const dispose of this.#disposers) dispose()
    this.#errorListeners.clear()
    this.terminal.dispose()
    this.element.remove()
  }
}

export function getTerminalRuntime(id: string, cwd: string | null): TerminalRuntime {
  let runtime = runtimes.get(id)
  if (!runtime) {
    runtime = new TerminalRuntime(id, cwd)
    runtimes.set(id, runtime)
    emit()
  }
  return runtime
}
export function findTerminalRuntime(id: string): TerminalRuntime | undefined {
  return runtimes.get(id)
}
export function destroyTerminalRuntime(id: string): void {
  const runtime = runtimes.get(id)
  runtimes.delete(id)
  runtime?.dispose()
  emit()
}
export function resetTerminalRuntimes(): void {
  for (const id of [...runtimes.keys()]) destroyTerminalRuntime(id)
}
subscribeTerminalDock(() => {
  for (const id of [...runtimes.keys()])
    if (id.startsWith('term_') && !findTerminalTab(id)) destroyTerminalRuntime(id)
})
