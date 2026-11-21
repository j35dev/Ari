// @vitest-environment node
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ desktopCapturer: {} }))
import { intersectRect, planCapture, sourceCrop } from './capture'
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
it('plans one native-resolution tile per display the window touches', () => {
  const plan = planCapture({ x: -200, y: 100, width: 900, height: 600 }, [
    { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1 },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 },
  ])
  expect(plan.scale).toBe(1.5)
  expect(plan.width).toBe(1350)
  expect(plan.height).toBe(900)
  expect(plan.thumbnailSize).toEqual({ width: 2880, height: 1620 })
  expect(plan.tiles).toEqual([
    {
      display: 0,
      area: { x: -200, y: 100, width: 200, height: 600 },
      output: { x: 0, y: 0, width: 300, height: 900 },
    },
    {
      display: 1,
      area: { x: 0, y: 100, width: 700, height: 600 },
      output: { x: 300, y: 0, width: 1050, height: 900 },
    },
  ])
})
it('caps a large window at 2560x1600 pixels instead of its native size', () => {
  const plan = planCapture({ x: 0, y: 0, width: 3200, height: 2000 }, [
    { bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 2 },
  ])
  expect(plan.width).toBe(2560)
  expect(plan.height).toBe(1600)
  expect(plan.scale).toBeCloseTo(0.8)
})
it('maps the window intersection into a screen thumbnail pixel grid', () => {
  const display = { x: -1280, y: 0, width: 1280, height: 720 }
  expect(
    sourceCrop({ x: -200, y: 100, width: 200, height: 600 }, display, { width: 1280, height: 720 }),
  ).toEqual({
    x: 1080,
    y: 100,
    width: 200,
    height: 600,
  })
  expect(
    sourceCrop({ x: -200, y: 100, width: 200, height: 600 }, display, {
      width: 2560,
      height: 1440,
    }),
  ).toEqual({ x: 2160, y: 200, width: 400, height: 1200 })
  expect(
    sourceCrop({ x: -5000, y: -5000, width: 10, height: 10 }, display, {
      width: 1280,
      height: 720,
    }),
  ).toEqual({ x: 0, y: 0, width: 0, height: 0 })
})
