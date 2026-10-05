import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: these suites drive the real gateway over real sockets,
    // and jsdom has no SubtleCrypto — which is exactly the API the device key
    // is built on. Component tests opt into jsdom with a docblock.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
  },
})
