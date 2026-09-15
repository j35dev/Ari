import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeInvitationFromUrl } from './app-state'

/**
 * The invitation arrives in the URL fragment and must not stay there.
 *
 * A fragment rather than a query because it never leaves the device — and
 * because of that, reading it is the only chance: leaving it in the address
 * bar means a screenshot, a share, or a reload hands the invitation to
 * whoever reads it next.
 */
describe('takeInvitationFromUrl', () => {
  const original = { location: globalThis.location, history: globalThis.history }

  afterEach(() => {
    Object.assign(globalThis, original)
    vi.restoreAllMocks()
  })

  function withUrl(href: string): { replaced: string[] } {
    const replaced: string[] = []
    Object.assign(globalThis, {
      location: { href },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaced.push(url)
        },
      },
    })
    return { replaced }
  }

  it('reads the invitation and clears it from the address bar', () => {
    const { replaced } = withUrl('https://ari.tailnet.ts.net/#pair=inv_abc123')
    expect(takeInvitationFromUrl('https://ari.tailnet.ts.net/#pair=inv_abc123')).toBe('inv_abc123')
    expect(replaced).toEqual(['https://ari.tailnet.ts.net/'])
  })

  it('treats a fragment without an invitation as nothing to do', () => {
    const { replaced } = withUrl('https://ari.tailnet.ts.net/#something-else')
    expect(takeInvitationFromUrl('https://ari.tailnet.ts.net/#something-else')).toBeNull()
    // Nothing is rewritten: this was not a pairing link.
    expect(replaced).toEqual([])
  })

  it('answers nothing for a plain visit', () => {
    withUrl('https://ari.tailnet.ts.net/')
    expect(takeInvitationFromUrl('https://ari.tailnet.ts.net/')).toBeNull()
  })

  it('takes the invitation even when other fragment fields are present', () => {
    withUrl('https://ari.tailnet.ts.net/#mode=dark&pair=inv_xyz')
    expect(takeInvitationFromUrl('https://ari.tailnet.ts.net/#mode=dark&pair=inv_xyz')).toBe('inv_xyz')
  })
})
