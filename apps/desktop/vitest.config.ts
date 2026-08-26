import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jsdom for component tests; node-side suites don't touch DOM APIs.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    // Component tests drive real timers and async IPC mocks; under a fully
    // parallel `pnpm verify` the default 5s is not enough on a loaded machine.
    testTimeout: 20_000,
  },
})
