import { defineConfig } from '@playwright/test'

// Electron E2E. Tests launch the BUILT app (out/main) via Playwright's _electron — so `npm run build`
// must run first (the `test:e2e` script does this). One worker: a single Electron app at a time.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
})
