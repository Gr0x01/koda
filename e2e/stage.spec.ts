import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Runtime confirmation for the STAGE dock (the tab-strip replacement): boots the BUILT app into a
 * throwaway project and walks the new shape — the rest state, staging a file from the Files tree,
 * the switcher menu, the desk strip, and the terminal shelf's stays-mounted contract. No engine
 * session needed: user file-opens land in the no-session editor by design.
 */

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
async function launchSeeded(projectPath: string): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'koda-stage-e2e-'))
  writeFileSync(
    join(userDataDir, 'koda-app-state.json'),
    JSON.stringify({ version: 1, openProjects: [projectPath], recentProjects: [projectPath] }),
  )
  writeFileSync(join(userDataDir, 'koda-settings.json'), JSON.stringify({ hasOnboarded: true }))
  return electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
}

function makeProject(): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-stage-proj-')))
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42\n')
  writeFileSync(join(project, 'style.css'), 'body { margin: 0; }\n')
  return project
}

test('stage: rest state → staged file → switcher swaps → desk strip opens the sheet', async () => {
  const project = makeProject()
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))

    // Fresh project, nothing staged — the stage rests instead of showing empty tool tabs.
    await expect(win.getByText('Nothing on stage yet')).toBeVisible({ timeout: 20_000 })

    // The desk strip is present and honest: this temp dir isn't a git repo.
    await expect(win.getByText('No version history', { exact: true })).toBeVisible()

    // Open a file from the Files tree → it takes the stage; the bar pill names it.
    await win.getByRole('button', { name: 'Files', exact: true }).click()
    await win.getByRole('button', { name: 'app.ts', exact: true }).click()
    const pill = win.getByTitle("Switch what's on stage")
    await expect(pill).toContainText('app.ts', { timeout: 20_000 })
    // Monaco actually rendered the file body on the stage.
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })

    // Second file joins the workbench and takes the stage; the switcher menu swaps back.
    await win.getByRole('button', { name: 'style.css', exact: true }).click()
    await expect(pill).toContainText('style.css')
    await pill.click()
    await win.getByTitle(join(project, 'app.ts')).click() // the menu row (titled by full path)
    await expect(pill).toContainText('app.ts')

    // The desk strip expands into the review sheet (no repo → the set-up state).
    await win.getByText('No version history', { exact: true }).click()
    await expect(win.getByRole('button', { name: 'Set up version control' })).toBeVisible({ timeout: 10_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('terminal shelf summons, and stays mounted when hidden (scrollback survives)', async () => {
  const project = makeProject()
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    // Summon the shelf from the stage bar.
    const termBtn = win.getByTitle('Terminal', { exact: true })
    await termBtn.waitFor({ timeout: 20_000 })
    await termBtn.click()
    const xterm = win.locator('.xterm').first()
    await expect(xterm).toBeVisible({ timeout: 20_000 })

    // Hide it — the shelf collapses to zero height but the xterm must STAY IN THE DOM (the pty and
    // scrollback live in that mounted view; unmounting would wipe the buffer).
    await win.getByTitle('Hide terminal').click()
    await expect(xterm).not.toBeVisible({ timeout: 10_000 })
    await expect(xterm).toBeAttached()
  } finally {
    await app.close()
  }
})
