import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Runtime confirmation for the WYSIWYG doc surface (Milkdown/Crepe): launches the BUILT app (so the
 * strict packaged CSP is applied — `isDev` is false), seeds app-state to boot straight into this
 * worktree as a project (avoids the native folder picker), opens README.md, and asserts the doc
 * renders with NO CSP violation — the one thing the static checks couldn't prove.
 */
const PROJECT_ROOT = process.cwd()

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
async function launchSeeded(projectPath: string): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'koda-doc-e2e-'))
  writeFileSync(
    join(userDataDir, 'koda-app-state.json'),
    JSON.stringify({ version: 1, openProjects: [projectPath], recentProjects: [projectPath] }),
  )
  // Skip the first-run onboarding wizard so boot lands straight in the project workspace.
  writeFileSync(join(userDataDir, 'koda-settings.json'), JSON.stringify({ hasOnboarded: true }))
  return electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
}

test('markdown opens as a WYSIWYG doc under the packaged CSP, no violations', async () => {
  const app = await launchSeeded(PROJECT_ROOT)
  const cspErrors: string[] = []
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('console', (m) => {
      if (m.type() === 'error' && /content security policy/i.test(m.text())) cspErrors.push(m.text())
    })
    win.on('pageerror', (e) => pageErrors.push(e.message))

    // The sidebar is doc-first by default; switch to the Files tree (where files are exact-name buttons).
    const filesTab = win.getByRole('button', { name: 'Files', exact: true })
    await filesTab.waitFor({ timeout: 20_000 })
    await filesTab.click()

    // Boot restores the project window → Files browser lists the root. Open README.md (a .md → defaults
    // to the doc view).
    const readme = win.getByRole('button', { name: 'README.md', exact: true })
    await readme.waitFor({ timeout: 20_000 })
    await readme.click()

    // Crepe mounts its ProseMirror editable area and renders the markdown as rich content.
    const prose = win.locator('.milkdown .ProseMirror')
    await expect(prose).toBeVisible({ timeout: 20_000 })
    // The README's H1 must have rendered as an actual heading element (markdown → rich), proving the
    // parse path ran — not raw text.
    await expect(win.locator('.milkdown .ProseMirror h1').first()).toBeVisible({ timeout: 10_000 })

    expect(cspErrors, `CSP violations:\n${cspErrors.join('\n')}`).toHaveLength(0)
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('New document creates a blank doc and opens it in the editor', async () => {
  // Isolated temp project so the created file is auto-discarded with the temp dir.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-proj-')))
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    const newDoc = win.getByRole('button', { name: 'New document' })
    await newDoc.waitFor({ timeout: 20_000 })
    await newDoc.click()

    // The blank doc opens in the WYSIWYG editor (the test's contract — file placement in the doc-first
    // sidebar is covered elsewhere; new docs land in the lazy Documents/ home, not the root tree).
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })
  } finally {
    await app.close()
  }
})
