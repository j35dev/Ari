import { describe, expect, it, vi } from 'vitest'
import { BrowserService, type BrowserGuest } from './browser-service'

function fakeGuest(): {
  guest: BrowserGuest
  loadURL: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
} {
  let url = 'about:blank'
  const loadURL = vi.fn(async (next: string) => {
    url = next
  })
  const goBack = vi.fn()
  const setBounds = vi.fn()
  const setVisible = vi.fn()
  const destroy = vi.fn()
  const guest: BrowserGuest = {
    loadURL,
    goBack,
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    getURL: () => url,
    getTitle: () => 'Example',
    isLoading: () => false,
    setBounds,
    setVisible,
    destroy,
  }
  return { guest, loadURL, goBack, setBounds, setVisible, destroy }
}

describe('BrowserService', () => {
  it('opens a tab, navigates http(s), and refuses file URLs', async () => {
    const { guest, loadURL } = fakeGuest()
    const service = new BrowserService(() => guest, vi.fn())

    const opened = await service.open('tab1')
    expect(opened.url).toBe('about:blank')

    const ok = await service.navigate('tab1', 'example.com')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.tab.url).toBe('https://example.com/')
    expect(loadURL).toHaveBeenCalledWith('https://example.com/')

    const refused = await service.navigate('tab1', 'file:///etc/passwd')
    expect(refused.ok).toBe(false)
    expect(loadURL).toHaveBeenCalledTimes(1)
  })

  it('moves, hides, and destroys the guest', async () => {
    const { guest, goBack, setBounds, setVisible, destroy } = fakeGuest()
    const service = new BrowserService(() => guest, vi.fn())
    await service.open('tab1')
    expect(service.go('tab1', 'back').id).toBe('tab1')
    expect(goBack).toHaveBeenCalledOnce()
    expect(service.layout('tab1', { x: 10, y: 20, width: 400, height: 300 }, true)).toBe(true)
    expect(setVisible).toHaveBeenCalledWith(true)
    expect(setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 400, height: 300 })
    expect(service.close('tab1')).toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
    expect(service.layout('tab1', { x: 0, y: 0, width: 1, height: 1 }, false)).toBe(false)
  })
})
