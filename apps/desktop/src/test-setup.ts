import '@testing-library/jest-dom/vitest'

// jsdom lacks ResizeObserver; components and @tanstack/virtual rely on it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
