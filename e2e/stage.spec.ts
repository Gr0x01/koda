import { test, expect } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda } from './support/koda'

/**
 * Runtime confirmation for the STAGE dock: boots the BUILT app into a throwaway project and walks the
 * shape — the stage staying away until it holds something, staging files from the Files tree as CO-OPEN
 * tabs, switching between them, closing them, and the picker putting the terminal and the changes on
 * stage as tabs of the same kind (no shelf, no strip). No engine session needed: user file-opens land
 * in the no-session editor by design.
 */

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
const launchSeeded = (projectPath: string) => launchKoda({ projectPath })

function makeProject(): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-stage-proj-')))
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42\n')
  writeFileSync(join(project, 'style.css'), 'body { margin: 0; }\n')
  return project
}

const addControl = 'Put something else on stage'

test('stage: away until a file lands on it → two co-open tabs → switch → close → away again', async () => {
  const project = makeProject()
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))

    // Fresh project, nothing staged: no panel at all — not an empty one asking to be filled.
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    await expect(win.getByRole('button', { name: addControl })).toHaveCount(0)

    // Files moved out of the rail, so the Find overlay (⌘P) is the file-opening path now. Typing the
    // name and taking the first hit is what a user does; it exercises the same `openFile` seam the
    // tree used to call.
    await win.keyboard.press('Meta+p')
    const find = win.getByPlaceholder('Find in this project')
    await find.waitFor({ timeout: 20_000 })
    await find.fill('app.ts')
    await win.getByRole('button', { name: 'app.ts', exact: true }).first().waitFor({ timeout: 20_000 })
    await win.keyboard.press('Enter')
    const tab = (name: string) => win.locator(`[data-staged][title="${join(project, name)}"]`)
    await expect(tab('app.ts')).toHaveAttribute('data-staged', 'true', { timeout: 20_000 })
    // Monaco actually rendered the file body on the stage.
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })

    // A second file joins as its OWN tab: the first stays open beside it (the co-open contract).
    await win.keyboard.press('Meta+p')
    const find2 = win.getByPlaceholder('Find in this project')
    await find2.waitFor({ timeout: 20_000 })
    await find2.fill('style.css')
    await win.getByRole('button', { name: 'style.css', exact: true }).first().waitFor({ timeout: 20_000 })
    await win.keyboard.press('Enter')
    await expect(tab('style.css')).toHaveAttribute('data-staged', 'true')
    await expect(tab('app.ts')).toHaveAttribute('data-staged', 'false')

    // Clicking the first tab selects it again, without closing the second.
    await tab('app.ts').click()
    await expect(tab('app.ts')).toHaveAttribute('data-staged', 'true')
    await expect(tab('style.css')).toBeVisible()

    // Closing a tab leaves the other one on stage; closing the last one takes the panel away again.
    await tab('style.css').getByRole('button', { name: 'Close style.css' }).click()
    await expect(tab('style.css')).toHaveCount(0)
    await expect(tab('app.ts')).toHaveAttribute('data-staged', 'true')
    await tab('app.ts').getByRole('button', { name: 'Close app.ts' }).click()
    await expect(win.getByRole('button', { name: addControl })).toHaveCount(0)

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('the picker stages the terminal and the changes as tabs, like any file', async () => {
  const project = makeProject()
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()

    // Bring the stage up with a file, then use the strip's add control for the rest. The rail button
    // is the readiness gate: the old tree click waited for the workspace implicitly, a global shortcut
    // does not, and firing it at a half-mounted window silently does nothing.
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    await win.keyboard.press('Meta+p')
    const pick = win.getByPlaceholder('Find in this project')
    await pick.waitFor({ timeout: 20_000 })
    await pick.fill('app.ts')
    await win.getByRole('button', { name: 'app.ts', exact: true }).first().waitFor({ timeout: 20_000 })
    await win.keyboard.press('Enter')
    await win.getByRole('button', { name: addControl }).waitFor({ timeout: 20_000 })

    // Terminal: a tab on the stage, not a shelf under it.
    await win.getByRole('button', { name: addControl }).click()
    await win.getByText('A shell in this project folder.').click()
    const xterm = win.locator('.xterm').first()
    await expect(xterm).toBeVisible({ timeout: 20_000 })
    await expect(win.locator('[data-staged][title="A shell in this project folder"]')).toHaveAttribute(
      'data-staged',
      'true',
    )

    // Switching tabs HIDES the terminal but must never unmount it — the pty and the scrollback live in
    // that mounted view, so a tab switch would otherwise wipe the buffer.
    await win.locator(`[data-staged][title="${join(project, 'app.ts')}"]`).click()
    await expect(xterm).not.toBeVisible({ timeout: 10_000 })
    await expect(xterm).toBeAttached()

    // Changes: also a tab. This temp dir isn't a repo, so the surface says so honestly.
    await win.getByRole('button', { name: addControl }).click()
    await win.getByText('Everything changed since your last version, ready to save.').click()
    await expect(win.getByRole('button', { name: 'Set up version control' })).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
  }
})
