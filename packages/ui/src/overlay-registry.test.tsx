import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  openOverlays,
  registerOverlay,
  subscribeOverlays,
  useOverlayRef,
} from './overlay-registry'

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

function Surface({ open }: { open: boolean }) {
  const ref = useOverlayRef()
  return open ? <div ref={ref} data-testid="surface" /> : null
}

describe('overlay registry', () => {
  it('tracks open overlays and tells subscribers once per batch of changes', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOverlays(listener)
    const menu = document.createElement('div')
    const scrim = document.createElement('div')
    const releaseMenu = registerOverlay(menu)
    const releaseScrim = registerOverlay(scrim)
    expect(openOverlays()).toEqual([menu, scrim])
    expect(listener).not.toHaveBeenCalled()
    await flush()
    expect(listener).toHaveBeenCalledOnce()

    releaseMenu()
    releaseMenu()
    await flush()
    expect(openOverlays()).toEqual([scrim])
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    releaseScrim()
    await flush()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(openOverlays()).toEqual([])
  })

  it('registers the element a ref is attached to, for as long as it is mounted', () => {
    const { getByTestId, rerender, unmount } = render(<Surface open />)
    expect(openOverlays()).toEqual([getByTestId('surface')])
    rerender(<Surface open={false} />)
    expect(openOverlays()).toEqual([])
    rerender(<Surface open />)
    expect(openOverlays()).toHaveLength(1)
    unmount()
    expect(openOverlays()).toEqual([])
  })
})
