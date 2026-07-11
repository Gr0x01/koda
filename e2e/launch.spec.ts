import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Launches the built Electron app with a throwaway userData dir (so persisted sessions from dev runs
// don't leak in and the empty state is deterministic). `onboarded` seeds koda-settings.json so the
// first-run wizard either shows or is skipped — the ProjectHome tests want it skipped.
async function launchKoda({ onboarded = true } = {}): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'koda-e2e-'))
  if (onboarded) {
    writeFileSync(join(userDataDir, 'koda-settings.json'), JSON.stringify({ hasOnboarded: true }))
  }
  return electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
}

// A fresh userData dir has no project, so an onboarded app boots into ProjectHome (the folder picker) —
// one project per window, since step 6. That's the deterministic first screen to assert on.
test('app launches and renders the ProjectHome folder picker', async () => {
  const app = await launchKoda()
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Open a project' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('renderer boots without an uncaught error', async () => {
  const app = await launchKoda()
  const errors: string[] = []
  try {
    const window = await app.firstWindow()
    window.on('pageerror', (e) => errors.push(e.message))
    // Let the first paint settle (engine probe, hydrate, ProjectHome render).
    await window.getByRole('heading', { name: 'Open a project' }).waitFor({ timeout: 15_000 })
    expect(errors, errors.join('\n')).toHaveLength(0)
  } finally {
    await app.close()
  }
})

// First run (no hasOnboarded) takes over the window with the onboarding wizard before ProjectHome.
// Advancing to the sign-in step exercises the real auth chain end-to-end (detectAuth → main → auth.ts →
// the bundled CLI → classify → renderer). This machine's CLI is logged in, so it resolves to the
// adaptive signed-in ✓ — proving the IPC wiring, not just that the wizard paints.
test('first run shows the onboarding wizard and detects sign-in', async () => {
  const app = await launchKoda({ onboarded: false })
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Welcome to Koda' })).toBeVisible({ timeout: 15_000 })
    await window.getByRole('button', { name: 'Continue' }).click()
    // The sign-in step detects the existing login and shows the signed-in heading (curly apostrophe).
    await expect(window.getByRole('heading', { name: /signed in/i })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
