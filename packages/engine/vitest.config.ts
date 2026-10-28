import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Git-backed suites shell out and move real repositories around; under a
    // fully parallel `pnpm verify` the default 5s is not enough on a loaded
    // Windows runner. Same reasoning as apps/desktop.
    testTimeout: 20_000,
  },
})
