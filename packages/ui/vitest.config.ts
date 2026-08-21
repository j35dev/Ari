import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Enables RTL auto-cleanup between tests (no manual afterEach(cleanup)).
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
