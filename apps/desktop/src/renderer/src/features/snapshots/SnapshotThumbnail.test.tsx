import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SnapshotThumbnail } from './SnapshotThumbnail'
import { markSnapshotArrival } from './arrival'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ useReducedMotionConfig: () => motion.reduced }))

// jsdom has neither image decoding nor the Web Animations API.
Element.prototype.animate ??= vi.fn()
HTMLImageElement.prototype.decode ??= async () => undefined

let complete: Array<() => void>
let animations: Array<{ finished: Promise<void>; cancel: ReturnType<typeof vi.fn> }>
beforeEach(() => {
  complete = []
  animations = []
  motion.reduced = false
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 80,
    y: 480,
    width: 28,
    height: 28,
  } as DOMRect)
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => {
    const finished = new Promise<void>((resolve) => complete.push(resolve))
    const animation = { finished, cancel: vi.fn() }
    animations.push(animation)
    return animation as unknown as Animation
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function capture() {
  const file = new File(['capture'], 'SnapShot.png', { type: 'image/png' })
  markSnapshotArrival(file, { capturedAt: Date.now(), animation: true, sound: false })
  return file
}

it('crossfades into the real thumbnail and cleans up all flight animations', async () => {
  render(<SnapshotThumbnail file={capture()} src="blob:captured-window" />)
  const thumbnail = screen.getByAltText('SnapShot.png')
  await waitFor(() => expect(document.querySelector('[data-snapshot-flight]')).not.toBeNull())
  expect(thumbnail.style.opacity).toBe('0')
  await act(async () => {
    complete.forEach((resolve) => resolve())
  })
  expect(document.querySelector('[data-snapshot-flight]')).toBeNull()
  expect(thumbnail.style.opacity).toBe('')
  expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true)
})

it('waits for decoded pixels and leaves the image visible if decoding is cancelled', async () => {
  let decoded!: () => void
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        decoded = resolve
      }),
  )
  const view = render(<SnapshotThumbnail file={capture()} src="blob:captured-window" />)
  expect(document.querySelector('[data-snapshot-flight]')).toBeNull()
  view.unmount()
  await act(async () => {
    decoded()
  })
  expect(document.querySelector('[data-snapshot-flight]')).toBeNull()
  expect(animations).toHaveLength(0)
})

it.each(['app', 'system'])('skips the flight for %s reduced motion', (preference) => {
  motion.reduced = preference === 'app'
  vi.stubGlobal('matchMedia', () => ({ matches: preference === 'system' }))
  render(<SnapshotThumbnail file={capture()} src="blob:captured-window" />)
  expect(document.querySelector('[data-snapshot-flight]')).toBeNull()
  expect(screen.getByAltText('SnapShot.png').style.opacity).toBe('')
})

it('removes the floating preview if the composer unmounts during the flight', async () => {
  const view = render(<SnapshotThumbnail file={capture()} src="blob:captured-window" />)
  await waitFor(() => expect(document.querySelector('[data-snapshot-flight]')).not.toBeNull())
  view.unmount()
  expect(document.querySelector('[data-snapshot-flight]')).toBeNull()
  expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true)
})
