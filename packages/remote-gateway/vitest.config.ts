import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Gateway suites bind sockets and use real timers; under a fully parallel
    // `pnpm verify` the default 5s is not enough on a loaded Windows runner.
    // Same reasoning as apps/desktop.
    testTimeout: 20_000,
  },
})
