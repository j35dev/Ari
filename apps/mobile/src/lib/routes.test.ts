import { describe, expect, it } from 'vitest'
import { readRoute, routeUrl } from './routes'

describe('workspace routes', () => {
  it('defaults to sessions and tolerates unknown destinations', () => {
    expect(readRoute('https://computer/?view=bogus')).toEqual({
      destination: 'sessions',
      sessionId: null,
    })
  })
  it('preserves the serving path, account computer selection, and invitation fragment', () => {
    const href = 'https://connect.example/app?computer=computer_1#pair=private'
    const url = routeUrl({ destination: 'projects', sessionId: 'session & space' }, href)
    expect(url).toBe(
      '/app?computer=computer_1&view=projects&session=session+%26+space#pair=private',
    )
    expect(readRoute(new URL(url, href).href)).toEqual({
      destination: 'projects',
      sessionId: 'session & space',
    })
    expect(routeUrl({ destination: 'sessions', sessionId: null }, new URL(url, href).href)).toBe(
      '/app?computer=computer_1#pair=private',
    )
  })
})
