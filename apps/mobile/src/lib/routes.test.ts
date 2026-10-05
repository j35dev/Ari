import { describe, expect, it } from 'vitest'
import { readRoute, routeUrl } from './routes'

describe('workspace routes', () => {
  it('opens on the session list, including from a link to a screen that no longer exists', () => {
    for (const view of ['bogus', 'projects', 'now', 'sessions'])
      expect(readRoute(`https://computer/?view=${view}`)).toEqual({
        destination: 'home',
        sessionId: null,
      })
    expect(readRoute('https://computer/?view=settings').destination).toBe('settings')
    expect(readRoute('https://computer/?view=new').destination).toBe('new')
  })
  it('preserves the serving path, account computer selection, and invitation fragment', () => {
    const href = 'https://connect.example/app?computer=computer_1#pair=private'
    const url = routeUrl({ destination: 'settings', sessionId: 'session & space' }, href)
    expect(url).toBe(
      '/app?computer=computer_1&view=settings&session=session+%26+space#pair=private',
    )
    expect(readRoute(new URL(url, href).href)).toEqual({
      destination: 'settings',
      sessionId: 'session & space',
    })
    expect(routeUrl({ destination: 'home', sessionId: null }, new URL(url, href).href)).toBe(
      '/app?computer=computer_1#pair=private',
    )
  })
})
