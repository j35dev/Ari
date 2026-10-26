import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Kept uniform with the other packages: these suites are pure and fast
    // today, but a shared default keeps a slow machine from turning a green
    // run red. Same reasoning as apps/desktop.
    testTimeout: 20_000,
  },
})
