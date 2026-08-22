import '@testing-library/jest-dom/vitest'
import { MotionGlobalConfig } from 'motion/react'

// Animations must be instant under test: AnimatePresence exits otherwise keep
// nodes mounted until animation frames advance, which jsdom never guarantees
// (two Select popovers could coexist and break role queries).
MotionGlobalConfig.skipAnimations = true

// jsdom lacks ResizeObserver; components and @tanstack/virtual rely on it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
