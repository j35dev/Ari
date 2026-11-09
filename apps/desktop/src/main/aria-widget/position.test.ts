// @vitest-environment node
import { expect, it } from 'vitest'
import { widgetBounds } from './position'

it('centers above the work-area edge, including a display left of the primary monitor', () => {
  expect(widgetBounds({ x: -1920, y: 120, width: 1920, height: 1040 })).toEqual({
    x: -1150,
    y: 1076,
    width: 380,
    height: 72,
  })
  expect(widgetBounds({ x: 2560, y: -1080, width: 1280, height: 1020 })).toEqual({
    x: 3010,
    y: -144,
    width: 380,
    height: 72,
  })
})

it('stays within a work area smaller than the normal pill window', () => {
  expect(widgetBounds({ x: 20, y: 30, width: 200, height: 50 })).toEqual({
    x: 20,
    y: 30,
    width: 200,
    height: 50,
  })
})
