import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Runtime confirmation for the Versions surface's Backup states: a repo one version ahead of its
 * remote shows "Push to GitHub · 1 version" + the graph's ✓-on-GitHub marker, the push actually
 * lands (card flips to the in-sync state), and a repo with NO remote offers the agent-driven
 * Publish path. The "remote" is a local bare repo — no network, no credentials, so the push is
 * deterministic.
 */

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
async function launchSeeded(projectPath: string): Promise<ElectronApplication> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'koda-versions-e2e-'))
  writeFileSync(
    join(userDataDir, 'koda-app-state.json'),
    JSON.stringify({ version: 1, openProjects: [projectPath], recentProjects: [projectPath] }),
  )
  writeFileSync(join(userDataDir, 'koda-settings.json'), JSON.stringify({ hasOnboarded: true }))
  return electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userDataDir}`] })
}

// A clean-tree git project with 2 versions; with a remote, the FIRST is pushed and the second isn't.
// `sideBranch` moves the work onto a feature branch (main stays behind at the first version).
function makeGitProject({ withRemote, sideBranch = false }: { withRemote: boolean; sideBranch?: boolean }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-versions-proj-')))
  const project = join(root, 'proj')
  mkdirSync(project)
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=Koda Test', '-c', 'user.email=test@example.com', ...args],
      { cwd },
    )
  }
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42\n')
  git(project, 'add', '-A')
  git(project, 'commit', '-q', '-m', 'first version')
  if (withRemote) {
    const bare = join(root, 'remote.git')
    git(root, 'init', '-q', '--bare', bare)
    git(project, 'remote', 'add', 'origin', bare)
    git(project, 'push', '-q', '-u', 'origin', 'main')
  }
  if (sideBranch) git(project, 'checkout', '-q', '-b', 'feat/thing')
  writeFileSync(join(project, 'app.ts'), 'export const answer = 43\n')
  git(project, 'add', '-A')
  git(project, 'commit', '-q', '-m', 'second version')
  return project
}

test('versions: Push to GitHub pushes the unpushed version and the card flips to in-sync', async () => {
  const project = makeGitProject({ withRemote: true })
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))

    await win.getByRole('button', { name: 'Versions', exact: true }).click()

    // One local-only version to push; the ledger's divider marks how far the remote already has.
    const pushBtn = win.getByRole('button', { name: /Push to GitHub/ })
    await expect(pushBtn).toBeVisible({ timeout: 20_000 })
    await expect(pushBtn).toContainText('1 version')
    await expect(win.getByText('On GitHub from here down')).toBeVisible()

    // The right pane defaulted to something real (both versions are committed → the latest version).
    await expect(win.getByText('What this version changed · 1')).toBeVisible()

    // Push to the local bare remote → the card settles into the quiet in-sync fact.
    await pushBtn.click()
    await expect(win.getByText(/^On GitHub ·/)).toBeVisible({ timeout: 20_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('versions: restore an old version lands as a new "Restored" version on top', async () => {
  const project = makeGitProject({ withRemote: false })
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))

    await win.getByRole('button', { name: 'Versions', exact: true }).click()

    // Pick the OLDER version in the history graph, then restore it (light inline confirm).
    await win.getByRole('button', { name: /first version/ }).click({ timeout: 20_000 })
    await win.getByRole('button', { name: 'Restore this version' }).click()
    await win.getByRole('button', { name: 'Restore', exact: true }).click()

    // The restore is a NEW version on top — never a rewrite. Tree stays clean (it was committed).
    await expect(win.getByText('Restored “first version”')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByText('Nothing changed since your last version.')).toBeVisible()

    // Restoring a state the files already match is refused with plain copy, not a mystery error.
    await win.getByRole('button', { name: /first version/ }).first().click()
    await win.getByRole('button', { name: 'Restore this version' }).click()
    await win.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(win.getByText('Your files already match this version.')).toBeVisible({ timeout: 10_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('versions: working on a side branch shows the finish-it banner', async () => {
  const project = makeGitProject({ withRemote: false, sideBranch: true })
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: 'Versions', exact: true }).click()

    await expect(win.getByText("You're on a side branch.")).toBeVisible({ timeout: 20_000 })
    // No session in a fresh window → the handoff waits, disabled.
    await expect(win.getByRole('button', { name: /finish it into main/ })).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('versions: no remote offers the agent-driven Publish path', async () => {
  const project = makeGitProject({ withRemote: false })
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: 'Versions', exact: true }).click()

    await expect(win.getByText('Your versions only exist on this computer', { exact: false })).toBeVisible({
      timeout: 20_000,
    })
    // No session in a fresh window → the button waits, disabled, rather than dead-ending.
    await expect(win.getByRole('button', { name: 'Publish to GitHub…' })).toBeDisabled()
  } finally {
    await app.close()
  }
})
