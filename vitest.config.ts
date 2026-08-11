import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Unit tests run in plain Node (no Electron runtime). Two aliases make main-process modules importable:
//  - @shared: the same alias electron.vite.config.ts uses.
//  - electron: a stub (test/electron-stub.ts), because main modules import `electron` transitively
//    (e.g. logger → app). The stub keeps imports from resolving to the electron binary path.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'shared'),
      electron: resolve(__dirname, 'test/electron-stub.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts'],
  },
})
