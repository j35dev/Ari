import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WidgetSnapshot } from '../../main/aria-widget/model'
import { WidgetApp } from './App'

vi.mock('../src/features/speech/recorder', () => ({
  startRecording: () =>
    Promise.resolve({
      stop: () => Promise.resolve(new Float32Array()),
      cancel: () => undefined,
      level: () => 0.1,
    }),
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('polls the level only while listening and clears the poll on release and unmount', async () => {
  vi.useFakeTimers()
  let receive!: (state: WidgetSnapshot) => void
  const hidden: WidgetSnapshot = {
    id: 0,
    phase: 'hidden',
    text: '',
    setup: false,
    theme: 'obsidian',
    reducedMotion: false,
  }
  window.ariaWidget = {
    invoke: () => Promise.resolve(hidden),
    onState: (callback) => {
      receive = callback
      return () => undefined
    },
  }
  await act(async () => {
    render(<WidgetApp />)
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    receive({ ...hidden, id: 1, phase: 'listening' })
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(1)
  // The meter's newest bar is the last one; at rest it is a single 3px cell.
  const meter = () => document.querySelector('.ari-levels i:last-child') as HTMLElement
  expect(meter().style.height).toBe('3px')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(meter().style.height).not.toBe('3px')
  await act(async () => {
    receive({ ...hidden, id: 2, phase: 'listening' })
    await Promise.resolve()
  })
  expect(meter().style.height).toBe('3px')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(meter().style.height).not.toBe('3px')
  await act(async () => {
    receive({ ...hidden, id: 2, phase: 'transcribing' })
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    receive({ ...hidden, id: 3, phase: 'listening' })
    await Promise.resolve()
  })
  expect(vi.getTimerCount()).toBe(1)
  expect(meter().style.height).toBe('3px')
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
})
