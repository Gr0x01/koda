import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

// Electron E2E. Tests launch the BUILT app (out/main) via Playwright's _electron — so `npm run build`
// must run first (the `test:e2e` script does this). One worker: a single Electron app at a time.
const artifactDir = process.env.KODA_LAB_ARTIFACTS

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  outputDir: artifactDir ? join(artifactDir, 'test-results') : 'test-results',
  reporter: artifactDir
    ? [
        ['list'],
        ['junit', { outputFile: join(artifactDir, 'junit.xml') }],
        ['html', { outputFolder: join(artifactDir, 'playwright-report'), open: 'never' }],
      ]
    : 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
