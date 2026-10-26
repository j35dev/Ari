import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The loop drives real processes and temp directories; under a fully
    // parallel `pnpm verify` the default 5s is not enough on a loaded
    // Windows runner. Same reasoning as apps/desktop.
    testTimeout: 20_000,
  },
})
