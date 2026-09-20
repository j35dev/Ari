import { isPickedElement, type PickedElement } from './browser-element'
import { CANCEL_PICK_SOURCE, PICKER_SOURCE, SNAPSHOT_SOURCE } from './browser-pick-script'
import { resolveBrowserUrl } from './browser-url'

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
  capturePage(rect?: BrowserBounds): Promise<Buffer | null>
  setBounds(bounds: BrowserBounds): void
  setVisible(visible: boolean): void
  destroy(): void
}

export type BrowserGuestFactory = (id: string, onUpdated: () => void) => BrowserGuest

interface Tab {
  guest: BrowserGuest
  error: string | null
}

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

  async runScript(id: string, code: string): Promise<unknown> {
    const tab = this.#tab(id)
    return tab.guest.executeJavaScript(code)
  }

  async screenshot(id: string): Promise<Buffer | null> {
    const tab = this.#tab(id)
    return tab.guest.capturePage()
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
