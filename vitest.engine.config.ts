import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// The engine-contract smoke test drives a REAL `claude` process (slow, spends tokens), so it lives
// outside the default `npm test` glob (src/**/*.test.ts) and runs only via `npm run test:engine-contract`.
// Same aliases as vitest.config.ts so the main-process adapter imports resolve; generous timeouts for
// live turns; single-threaded so the five seams run in order against one shared session.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      electron: resolve(__dirname, 'test/electron-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/engine-contract/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
