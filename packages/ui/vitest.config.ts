import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Enables RTL auto-cleanup between tests (no manual afterEach(cleanup)).
    globals: true,
    // Component tests drive real timers; under a fully parallel `pnpm verify`
    // the default 5s is not enough on a loaded machine.
    testTimeout: 20_000,
    setupFiles: ['./src/test-setup.ts'],
  },
})
