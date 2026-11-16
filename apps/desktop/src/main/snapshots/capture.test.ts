// @vitest-environment node
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ desktopCapturer: {} }))
import { sourceMatchesWindow, intersectRect } from './capture'
it('selects only the exact foreground native window id', () => {
  expect(sourceMatchesWindow('window:123:0', '123')).toBe(true)
  expect(sourceMatchesWindow('window:1234:0', '123')).toBe(false)
  expect(sourceMatchesWindow('screen:123:0', '123')).toBe(false)
  expect(sourceMatchesWindow('window:456:0', '123')).toBe(false)
})
it('crops only the window intersection on each display, including negative coordinates', () => {
  const window = { x: -200, y: 100, width: 900, height: 600 }
  expect(intersectRect(window, { x: -1280, y: 0, width: 1280, height: 720 })).toEqual({
    x: -200,
    y: 100,
    width: 200,
    height: 600,
  })
  expect(intersectRect(window, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
    x: 0,
    y: 100,
    width: 700,
    height: 600,
  })
  expect(intersectRect(window, { x: 1920, y: 0, width: 1280, height: 720 })).toBeNull()
})
