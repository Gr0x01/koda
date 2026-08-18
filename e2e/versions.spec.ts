import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda } from './support/koda'

/**
 * Runtime confirmation for the Versions timeline's GitHub seam: a repo one version ahead of its
 * remote shows "Push 1 version" on the seam where the boundary is, the push actually lands (the seam
 * settles into "Everything is on GitHub"), and a repo with NO remote offers the agent-driven Publish
 * path instead. The "remote" is a local bare repo — no network, no credentials, so the push is
 * deterministic.
 */

// The footer's one Versions chip names its unsaved count for screen readers ("Versions, 2 changes not
// yet saved"), so match the prefix rather than the whole label — a dirty fixture must not break the
// way in.
async function openVersions(win: Page): Promise<void> {
  await win.getByRole('button', { name: /^Versions/ }).click()
}

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
const launchSeeded = (projectPath: string) => launchKoda({ projectPath })

// A clean-tree git project with 2 versions; with a remote, the FIRST is pushed and the second isn't.
// `sideBranch` moves the work onto a feature branch (main stays behind at the first version).
// `waitingBranch` leaves one more clean committed branch behind while returning to main.
function makeGitProject({
  withRemote,
  sideBranch = false,
  waitingBranch = false,
}: {
  withRemote: boolean
  sideBranch?: boolean
  waitingBranch?: boolean
}): string {
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
  // Persist identity in the fixture itself. Relying on the developer's global ~/.gitconfig made the
  // restore path pass on a workstation but fail correctly in Koda E2E's empty credential home.
  git(project, 'config', 'user.name', 'Koda Test')
  git(project, 'config', 'user.email', 'test@example.com')
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
  if (waitingBranch) {
    git(project, 'checkout', '-q', '-b', 'agent/waiting')
    writeFileSync(join(project, 'waiting.ts'), 'export const waiting = true\n')
    git(project, 'add', '-A')
    git(project, 'commit', '-q', '-m', 'waiting side work')
    git(project, 'checkout', '-q', 'main')
  }
  return project
}

test('versions: the seam pushes the unpushed version and settles into the all-safe state', async () => {
  const project = makeGitProject({ withRemote: true })
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))

    await openVersions(win)

    // One local-only version to push; the seam marks how far the remote already has.
    const pushBtn = win.getByRole('button', { name: /Push 1 version/ })
    await expect(pushBtn).toBeVisible({ timeout: 20_000 })
    await expect(pushBtn).toContainText('1 version')
    await expect(win.getByText('On GitHub from here down')).toBeVisible()

    // The right pane defaulted to something real (both versions are committed → the latest version).
    await expect(win.getByText('What this version changed · 1')).toBeVisible()

    // Push to the local bare remote → the seam settles into the quiet in-sync fact.
    await pushBtn.click()
    await expect(win.getByText('Everything is on GitHub')).toBeVisible({ timeout: 20_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('versions: recent history keeps a compact scan rhythm', async () => {
  const project = makeGitProject({ withRemote: false })
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await openVersions(win)

    const dayRow = win.getByText('Today', { exact: true }).locator('..')
    const versionRow = win.getByRole('button', { name: 'second version', exact: true }).locator('..')
    await expect(dayRow).toBeVisible({ timeout: 20_000 })
    await expect(versionRow).toBeVisible()

    expect(await dayRow.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(32)
    expect(await versionRow.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(40)
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

    await openVersions(win)

    // Pick the OLDER version in the timeline, then restore it (light inline confirm).
    await win.getByRole('button', { name: /first version/ }).click({ timeout: 20_000 })
    await win.getByRole('button', { name: 'Restore this version' }).click()
    await win.getByRole('button', { name: 'Restore', exact: true }).click()

    // The restore is a NEW version on top — never a rewrite. Tree stays clean (it was committed).
    await expect(win.getByText('Restored “first version”')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByText('Nothing waiting. New work shows up here.')).toBeVisible()

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
    await openVersions(win)

    await expect(win.getByText("You're on a side branch.")).toBeVisible({ timeout: 20_000 })
    // No session in a fresh window → the handoff waits, disabled.
    await expect(win.getByRole('button', { name: /finish it into main/ })).toBeDisabled()
  } finally {
    await app.close()
  }
})

// A feature branch created from pushed main has shared history already on GitHub, even though its own
// remote ref does not exist. The seam therefore talks about the branch, never a made-up commit count.
test('versions: a never-pushed branch offers to push the branch without overstating its history', async () => {
  const project = makeGitProject({ withRemote: true, sideBranch: true })
  // Leave an unsaved change too: the footer chip then names its count for screen readers, which is
  // exactly where a whole-label selector used to lose the way into this surface.
  writeFileSync(join(project, 'notes.md'), 'a draft\n')
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await openVersions(win)

    await expect(win.getByText('1 change not yet saved')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByText("This branch hasn't been pushed to GitHub yet")).toBeVisible()
    await expect(win.getByText('On GitHub from here down')).toHaveCount(0)
    await expect(win.getByRole('button', { name: 'Push this branch' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('versions: the footer tracks a clean unmerged side line through its removal', async () => {
  const project = makeGitProject({ withRemote: false, waitingBranch: true })
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await expect(
      win.getByRole('button', { name: /Versions, side-line work is waiting/ }),
    ).toBeVisible({ timeout: 20_000 })

    await openVersions(win)
    await win.getByRole('button', { name: 'Review' }).click()
    await win.getByRole('button', { name: 'Discard this branch' }).click()
    await win.getByRole('button', { name: 'Discard branch' }).click()

    // The timeline and the always-visible cue share the post-mutation refresh; neither waits for a
    // focus change or another agent turn before acknowledging that the side line is gone.
    await expect(win.getByRole('button', { name: 'Versions', exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.getByText('agent/waiting')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('versions: no remote offers the agent-driven Publish path', async () => {
  const project = makeGitProject({ withRemote: false })
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await openVersions(win)

    await expect(win.getByText('Your versions only exist on this computer', { exact: false })).toBeVisible({
      timeout: 20_000,
    })
    // No session in a fresh window → the button waits, disabled, rather than dead-ending.
    await expect(win.getByRole('button', { name: 'Publish to GitHub…' })).toBeDisabled()
  } finally {
    await app.close()
  }
})
