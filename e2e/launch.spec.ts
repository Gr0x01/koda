import { test, expect } from '@playwright/test'
import { launchKoda } from './support/koda'

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
// Ordinary E2E has an empty account home, so onboarding is deterministic and cannot touch a developer's
// subscription. The explicit @mac-account assay below owns the live Keychain/shared-home contract.
test('first run shows onboarding and a deterministic signed-out state', async () => {
  const app = await launchKoda({ onboarded: false })
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Welcome to Koda' })).toBeVisible({ timeout: 15_000 })
    await window.getByRole('button', { name: 'Continue' }).click()
    await expect(window.getByRole('heading', { name: 'Connect your AI' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('first run detects this Mac account @mac-account', async () => {
  test.skip(
    process.platform !== 'darwin' || process.env.KODA_E2E_REAL_ACCOUNTS !== '1',
    'explicit logged-in Mac assay only',
  )
  const app = await launchKoda({ onboarded: false, realAccounts: true })
  try {
    const window = await app.firstWindow()
    await expect(window.getByRole('heading', { name: 'Welcome to Koda' })).toBeVisible({ timeout: 15_000 })
    await window.getByRole('button', { name: 'Continue' }).click()
    await expect(window.getByRole('heading', { name: /connected/i })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})
