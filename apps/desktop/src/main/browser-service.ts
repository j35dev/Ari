import type { ConsoleEntry } from './browser-console'
import { isPickedElement, type PickedElement } from './browser-element'
import { CANCEL_PICK_SOURCE, PICKER_SOURCE, SNAPSHOT_SOURCE } from './browser-pick-script'
import { resolveBrowserUrl } from './browser-url'

export const KEY_MODIFIERS = ['shift', 'ctrl', 'alt', 'meta'] as const
export const POINTER_ACTIONS = ['click', 'down', 'up', 'move', 'drag'] as const
export const POINTER_BUTTONS = ['left', 'middle', 'right'] as const
export type KeyModifier = (typeof KEY_MODIFIERS)[number]
export type PointerAction = (typeof POINTER_ACTIONS)[number]
export type PointerButton = (typeof POINTER_BUTTONS)[number]

/** Pointer input at viewport CSS px. `to` is the drag end; other actions ignore it. */
export interface PointerInput {
  action: PointerAction
  x: number
  y: number
  to?: { x: number; y: number }
  button: PointerButton
  modifiers: KeyModifier[]
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  error: string | null
  /** True when an agent just drove this tab — the shell should show the pane. */
  reveal?: boolean
}

/** One Chromium guest the service positions and navigates. Injected in tests. */
export interface BrowserGuest {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  executeJavaScript(code: string): Promise<unknown>
  /** With `size`, the image is scaled to that many pixels (e.g. CSS px from device px). */
  capturePage(
    rect?: BrowserBounds,
    format?: 'png' | 'jpeg',
    size?: { width: number; height: number },
  ): Promise<Buffer | null>
  /** Console history for this tab, oldest first; cleared when the page navigates. */
  consoleEntries(): ConsoleEntry[]
  sendKey(key: string, phase: 'down' | 'up', modifiers: KeyModifier[]): void
  sendMouse(
    phase: 'down' | 'up' | 'move',
    x: number,
    y: number,
    button: PointerButton,
    modifiers: KeyModifier[],
  ): void
  setBounds(bounds: BrowserBounds): void
  setVisible(visible: boolean): void
  destroy(): void
}

export type BrowserGuestFactory = (id: string, onUpdated: () => void) => BrowserGuest

/** The shell webContents events after which no panel is left to place a guest. */
export interface ShellResetSource {
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
}

/**
 * Guests are native views stacked over the shell, positioned by the renderer.
 * A shell reload or renderer crash skips React's unmount cleanup, so nothing
 * would ever hide them and they would float over the fresh UI.
 */
export function hideGuestsOnShellReset(
  shell: ShellResetSource,
  browsers: Pick<BrowserService, 'hideAll'>,
): void {
  shell.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) browsers.hideAll()
  })
  shell.on('render-process-gone', () => browsers.hideAll())
}

interface Tab {
  guest: BrowserGuest
  error: string | null
}

const DRAG_STEPS = 10

/**
 * Owns in-app browser tabs. The factory builds the Electron guest; this
 * class is the navigation, layout, and snapshot policy so tests do not
 * need Chromium.
 */
export class BrowserService {
  readonly #tabs = new Map<string, Tab>()
  readonly #createGuest: BrowserGuestFactory
  readonly #onUpdated: (state: BrowserTabState) => void

  constructor(createGuest: BrowserGuestFactory, onUpdated: (state: BrowserTabState) => void) {
    this.#createGuest = createGuest
    this.#onUpdated = onUpdated
  }

  async open(id: string, url?: string): Promise<BrowserTabState> {
    if (this.#tabs.get(id) === undefined) {
      const tab: Tab = { guest: this.#createGuest(id, () => this.#emit(id)), error: null }
      this.#tabs.set(id, tab)
    }
    if (url !== undefined && url !== '') {
      const result = await this.navigate(id, url)
      if (result.ok) return result.tab
    }
    return this.snapshot(id)
  }

  async navigate(
    id: string,
    input: string,
  ): Promise<{ ok: true; tab: BrowserTabState } | { ok: false; error: string }> {
    const tab = this.#tab(id)
    const resolved = resolveBrowserUrl(input)
    if (!resolved.ok) return resolved
    tab.error = null
    try {
      await tab.guest.loadURL(resolved.url)
    } catch (error: unknown) {
      tab.error = error instanceof Error ? error.message : String(error)
    }
    this.#emit(id)
    return { ok: true, tab: this.snapshot(id) }
  }

  go(id: string, action: 'back' | 'forward' | 'reload'): BrowserTabState {
    const tab = this.#tab(id)
    if (action === 'back') tab.guest.goBack()
    else if (action === 'forward') tab.guest.goForward()
    else tab.guest.reload()
    tab.error = null
    this.#emit(id)
    return this.snapshot(id)
  }

  layout(id: string, bounds: BrowserBounds, visible: boolean): boolean {
    const tab = this.#tabs.get(id)
    if (tab === undefined) return false
    tab.guest.setVisible(visible)
    if (visible) tab.guest.setBounds(bounds)
    return true
  }

  /** Hides every guest; each keeps its page for the next panel that asks for it. */
  hideAll(): void {
    for (const tab of this.#tabs.values()) tab.guest.setVisible(false)
  }

  close(id: string): boolean {
    const tab = this.#tabs.get(id)
    if (tab === undefined) return false
    tab.guest.destroy()
    this.#tabs.delete(id)
    return true
  }

  snapshot(id: string): BrowserTabState {
    const tab = this.#tab(id)
    const url = tab.guest.getURL()
    return {
      id,
      url: url.length > 0 ? url : 'about:blank',
      title: tab.guest.getTitle(),
      canGoBack: tab.guest.canGoBack(),
      canGoForward: tab.guest.canGoForward(),
      loading: tab.guest.isLoading(),
      error: tab.error,
    }
  }

  async pick(
    id: string,
  ): Promise<
    { ok: true; element: PickedElement; pngBase64: string | null } | { ok: false; error: string }
  > {
    const tab = this.#tab(id)
    await tab.guest.executeJavaScript(CANCEL_PICK_SOURCE)
    const raw = await tab.guest.executeJavaScript(PICKER_SOURCE)
    if (raw === null || raw === undefined) return { ok: false, error: 'cancelled' }
    if (!isPickedElement(raw)) return { ok: false, error: 'pick returned no element' }
    const png = await tab.guest.capturePage({
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.max(1, Math.round(raw.width)),
      height: Math.max(1, Math.round(raw.height)),
    })
    return { ok: true, element: raw, pngBase64: png ? png.toString('base64') : null }
  }

  async cancelPick(id: string): Promise<boolean> {
    const tab = this.#tabs.get(id)
    if (tab === undefined) return false
    await tab.guest.executeJavaScript(CANCEL_PICK_SOURCE)
    return true
  }

  async pageSnapshot(id: string): Promise<unknown> {
    const tab = this.#tab(id)
    return tab.guest.executeJavaScript(SNAPSHOT_SOURCE)
  }

  consoleEntries(id: string): ConsoleEntry[] {
    return this.#tab(id).guest.consoleEntries()
  }

  async runScript(id: string, code: string): Promise<unknown> {
    const tab = this.#tab(id)
    return tab.guest.executeJavaScript(code)
  }

  /** A cheap JPEG of the whole page, for the stand-in shown while app UI covers it. */
  async still(id: string): Promise<string | null> {
    const jpeg = await this.#tab(id).guest.capturePage(undefined, 'jpeg')
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null
  }

  /**
   * A JPEG of the viewport for agents, scaled to CSS px so a point read off it
   * is the point browser_pointer takes, whatever the device scale.
   */
  async screenshot(id: string): Promise<string | null> {
    const { guest } = this.#tab(id)
    const { width, height } = await viewportSize(guest)
    const jpeg = await guest.capturePage(undefined, 'jpeg', { width, height })
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null
  }

  /** Holds `key` down in the page for `holdMs`, then releases it. The key up is always sent. */
  async key(id: string, key: string, holdMs: number, modifiers: KeyModifier[] = []): Promise<void> {
    const { guest } = this.#tab(id)
    try {
      guest.sendKey(key, 'down', modifiers)
      await new Promise((resolve) => setTimeout(resolve, holdMs))
    } finally {
      guest.sendKey(key, 'up', modifiers)
    }
  }

  /**
   * Sends pointer input to the page. A point outside the viewport throws before
   * anything is sent; a click or drag always releases the button it pressed.
   */
  async pointer(id: string, input: PointerInput): Promise<void> {
    const { guest } = this.#tab(id)
    const { action, button, modifiers } = input
    const from = { x: Math.round(input.x), y: Math.round(input.y) }
    const to =
      action === 'drag' && input.to !== undefined
        ? { x: Math.round(input.to.x), y: Math.round(input.to.y) }
        : from
    const { width, height } = await viewportSize(guest)
    for (const { x, y } of [from, to]) {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(
          `${String(x)},${String(y)} is outside the ${String(width)}x${String(height)} viewport`,
        )
      }
    }
    const send = (phase: 'down' | 'up' | 'move', x: number, y: number): void =>
      guest.sendMouse(phase, x, y, button, modifiers)
    if (action === 'down' || action === 'up' || action === 'move') {
      send(action, from.x, from.y)
      return
    }
    try {
      send('down', from.x, from.y)
      if (action === 'drag') {
        for (let step = 1; step <= DRAG_STEPS; step += 1) {
          const t = step / DRAG_STEPS
          send(
            'move',
            Math.round(from.x + (to.x - from.x) * t),
            Math.round(from.y + (to.y - from.y) * t),
          )
        }
      }
    } finally {
      send('up', to.x, to.y)
    }
  }

  reveal(id: string): void {
    this.#onUpdated({ ...this.snapshot(id), reveal: true })
  }

  has(id: string): boolean {
    return this.#tabs.has(id)
  }

  dispose(): void {
    for (const id of [...this.#tabs.keys()]) this.close(id)
  }

  #tab(id: string): Tab {
    const tab = this.#tabs.get(id)
    if (tab === undefined) throw new Error(`unknown browser tab ${id}`)
    return tab
  }

  #emit(id: string): void {
    this.#onUpdated(this.snapshot(id))
  }
}

/** The page's viewport in CSS px, the unit of browser_pointer and browser_screenshot. */
async function viewportSize(guest: BrowserGuest): Promise<{ width: number; height: number }> {
  const viewport: unknown = await guest.executeJavaScript('[innerWidth, innerHeight]')
  const [width, height] = Array.isArray(viewport) ? (viewport as unknown[]) : []
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error('could not read the viewport size')
  }
  return { width, height }
}
