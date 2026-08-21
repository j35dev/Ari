import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // jsdom for component tests; node-side suites don't touch DOM APIs.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
