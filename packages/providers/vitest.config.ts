import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Account and extension discovery walks real home directories; under a
    // fully parallel `pnpm verify` the default 5s is not enough on a loaded
    // Windows runner. Same reasoning as apps/desktop.
    testTimeout: 20_000,
  },
})
