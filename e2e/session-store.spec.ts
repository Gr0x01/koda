import { test, expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda } from './support/koda'

/**
 * Runtime proof for the half unit tests can't reach: main refusing to report an unreadable store as
 * empty only matters if the RENDERER then declines to hydrate — because hydrating is what un-gates the
 * 500ms debounced save that would write that emptiness back over the user's real file, unattended,
 * with no interaction at all. So this boots the BUILT app onto a deliberately unreadable store, lets
 * the debounce window pass several times over, quits (which flushes pending saves), and checks the
 * file's bytes are byte-for-byte what they were. Same shape for the archive index, whose save fires on
 * every boot rather than only on a change.
 */

async function launchSeeded(projectPath: string, userDataDir: string): Promise<ElectronApplication> {
  return launchKoda({ projectPath, userDataDir })
}

/** The same filenames main derives (sha256 of the project root, first 16 hex) — session-store.ts. */
const hash = (projectPath: string): string => createHash('sha256').update(projectPath).digest('hex').slice(0, 16)
const storeName = (projectPath: string): string => `koda-sessions-${hash(projectPath)}.json`
const archiveName = (projectPath: string): string => `koda-archive-${hash(projectPath)}.json`
/** Where a session's archived transcript lands — sha256 of the session id, first 32 hex, under
 *  `koda-archive-<hash>.bodies/` (session-store.ts). */
const bodyName = (sessionId: string): string =>
  `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`

/** A throwaway project + userData pair, seeded to boot straight into the workspace. */
function scratch(): { project: string; userDataDir: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-store-proj-')))
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42\n')
  return { project, userDataDir: mkdtempSync(join(tmpdir(), 'koda-store-e2e-')) }
}

test('an unreadable session store survives a full boot + quit instead of being rewritten empty', async () => {
  const { project, userDataDir } = scratch()

  // A store the app can't parse — the realistic shape is version/schema drift, but a torn file reaches
  // the same branch and is unambiguous to assert on.
  const storeFile = join(userDataDir, storeName(project))
  const original = '{"version":2,"activeId":"s1","sessions":[{"id":"s1","label":"Months of real work"'
  writeFileSync(storeFile, original)

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    // The workspace renders (nothing restored — that part is expected and fine).
    await expect(win.getByRole('button', { name: 'New chat' })).toBeVisible({ timeout: 20_000 })
    // Well past the 500ms save debounce, and past the store churn a boot produces on its own.
    await win.waitForTimeout(4000)
  } finally {
    await app.close() // also fires the pre-quit flush, the other path that writes this file
  }

  // Non-vacuity: the `.corrupt-<ts>.bak` proves the app actually READ this file and failed on it (a
  // wrong hash would otherwise make "unchanged" trivially true).
  const backups = readdirSync(userDataDir).filter((n) => n.startsWith(`${storeName(project)}.corrupt-`))
  expect(backups, `no .corrupt backup in ${userDataDir} — did main ever read the store?`).toHaveLength(1)
  expect(readFileSync(join(userDataDir, backups[0]), 'utf8')).toBe(original)

  expect(readFileSync(storeFile, 'utf8')).toBe(original)
})

test('an unreadable archive index survives a boot instead of being rewritten empty', async () => {
  const { project, userDataDir } = scratch()

  // The archive save is the more dangerous of the two: it guards on reference identity and hydrate
  // always installs a fresh array, so it fires on EVERY boot, interaction or not.
  const indexFile = join(userDataDir, archiveName(project))
  const original = '{"version":2,"archived":[{"id":"a","label":"Last quarter","cwd":"/x","archivedAt":1}'
  writeFileSync(indexFile, original)

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    await expect(win.getByRole('button', { name: 'New chat' })).toBeVisible({ timeout: 20_000 })
    await win.waitForTimeout(4000)
  } finally {
    await app.close()
  }

  const backups = readdirSync(userDataDir).filter((n) => n.startsWith(`${archiveName(project)}.corrupt-`))
  expect(backups, `no .corrupt backup in ${userDataDir} — did main ever read the index?`).toHaveLength(1)
  expect(readFileSync(indexFile, 'utf8')).toBe(original)
})

/** A healthy, schema-valid store with one session — for the positive control below, and as the base a
 *  corrupt archive index is layered onto for the archive-block test. */
function seedHealthyStore(userDataDir: string, project: string, label: string): string {
  const storeFile = join(userDataDir, storeName(project))
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 's1',
      // A non-empty `items` matters: main's boot-time pruneGhostSessions drops any session with no
      // items AND no matching on-disk Claude conversation ("started but nothing was ever said") — an
      // empty-items fixture would silently vanish before the renderer even asks to load.
      sessions: [{ id: 's1', label, cwd: project, items: [{ id: 1, kind: 'user', text: 'hello' }] }],
    }),
  )
  return storeFile
}

// The positive control the two tests above were missing: without this, an implementation that just
// hard-disabled ALL persistence (not only for the unreadable-store case) would pass the whole suite.
test('a healthy session store hydrates on boot, and a change is written back to disk', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = seedHealthyStore(userDataDir, project, 'Alpha project chat')

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    const row = win.locator('aside').getByText('Alpha project chat', { exact: true })
    await expect(row, 'the seeded session never appeared — hydration itself is broken').toBeVisible({
      timeout: 20_000,
    })

    // The cheapest real state change that rides the same persisted `sessions` field the corruption
    // tests guard: double-click → inline rename input → Enter.
    await row.dblclick()
    const input = win.locator('aside input')
    await input.fill('Renamed after boot')
    await input.press('Enter')

    await win.waitForTimeout(1500) // past the 500ms debounce
  } finally {
    await app.close()
  }

  const saved = JSON.parse(readFileSync(storeFile, 'utf8'))
  expect(saved.sessions[0].label).toBe('Renamed after boot')
  expect(saved.sessions[0].userNamed).toBe(true)
})

test('an archived chat cannot return from a stale hot store, and repeated archive rows collapse', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = join(userDataDir, storeName(project))
  const indexFile = join(userDataDir, archiveName(project))
  const now = Date.now()

  // This is the exact split-brain state from the regression: the small archive write landed, but the
  // much larger hot-store save never crossed Electron IPC, so the same id remains live on disk. Each
  // retry then prepended another cold row for that id.
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'still-live',
      sessions: [
        {
          id: 'keeps-returning',
          label: 'Keeps coming back',
          cwd: project,
          items: [{ id: 1, kind: 'user', text: 'archive this' }],
        },
        {
          id: 'still-live',
          label: 'Actually live',
          cwd: project,
          items: [{ id: 2, kind: 'user', text: 'keep this one' }],
        },
      ],
    }),
  )
  writeFileSync(
    indexFile,
    JSON.stringify({
      version: 2,
      archived: [
        { id: 'keeps-returning', label: 'Latest archive click', cwd: project, archivedAt: now },
        { id: 'keeps-returning', label: 'Earlier archive click', cwd: project, archivedAt: now - 1000 },
      ],
    }),
  )
  const bodiesDir = `${indexFile.replace(/\.json$/, '')}.bodies`
  mkdirSync(bodiesDir)
  writeFileSync(
    join(bodiesDir, bodyName('keeps-returning')),
    JSON.stringify({ items: [{ id: 1, kind: 'user', text: 'archive this' }] }),
  )

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    await expect(win.locator('aside').getByText('Actually live', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.locator('aside').getByText('Keeps coming back', { exact: true })).toHaveCount(0)

    // One id means one archive, however many times the user retried the click. The first row is the
    // newest one, so its metadata wins when the index repairs itself.
    const archived = win.getByRole('button', { name: 'Archived chats (1)' })
    await expect(archived).toBeVisible()
    await archived.hover()
    await expect(win.getByText('Latest archive click', { exact: true })).toBeVisible()
    await expect(win.getByText('Earlier archive click', { exact: true })).toHaveCount(0)
    await win.waitForTimeout(1500) // let the ordinary renderer debounce run after main's repair
  } finally {
    await app.close()
  }

  const hot = JSON.parse(readFileSync(storeFile, 'utf8'))
  expect(hot.sessions.map((session: { id: string }) => session.id)).toEqual(['still-live'])
  const cold = JSON.parse(readFileSync(indexFile, 'utf8'))
  expect(cold.archived).toEqual([
    expect.objectContaining({ id: 'keeps-returning', label: 'Latest archive click' }),
  ])
})

test('archive metadata without a readable body keeps the live fallback and tells the user', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = join(userDataDir, storeName(project))
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 's1',
      sessions: [
        {
          id: 's1',
          label: 'Only readable copy',
          cwd: project,
          items: [{ id: 1, kind: 'user', text: 'hello' }],
        },
        {
          id: 's2',
          label: 'Archive something else',
          cwd: project,
          items: [{ id: 2, kind: 'user', text: 'unrelated' }],
        },
      ],
    }),
  )
  const indexFile = join(userDataDir, archiveName(project))
  writeFileSync(
    indexFile,
    JSON.stringify({
      version: 2,
      archived: [
        { id: 's1', label: 'Broken archive copy', cwd: project, archivedAt: Date.now() },
      ],
    }),
  )

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    await expect(win.locator('aside').getByText('Only readable copy', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.getByText('Koda couldn’t read the archived copy of 1 chat.', { exact: true })).toBeVisible()
    await expect(win.getByText('Its live copy is still here and nothing was deleted.', { exact: false })).toBeVisible()
    // The broken row remains on disk for recovery, but it cannot appear as a restorable archive in
    // this run because its transcript body is precisely what could not be read.
    await expect(win.getByRole('button', { name: /Archived chats/ })).toHaveCount(0)

    // Any later archive write is a complete index replacement. Archiving an unrelated live chat must
    // carry the hidden recovery row forward instead of silently orphaning the broken body metadata.
    const unrelated = win.locator('aside').getByText('Archive something else', { exact: true })
    await expect(unrelated).toBeVisible()
    await unrelated.click({ button: 'right' })
    await win.getByText('Archive session').click()
    await expect(unrelated).toHaveCount(0)
    await expect(win.getByRole('button', { name: 'Archived chats (1)' })).toBeVisible()
  } finally {
    await app.close()
  }

  const hot = JSON.parse(readFileSync(storeFile, 'utf8'))
  expect(hot.sessions.map((session: { id: string }) => session.id)).toEqual(['s1'])
  const cold = JSON.parse(readFileSync(indexFile, 'utf8'))
  expect(cold.archived.map((meta: { id: string }) => meta.id).sort()).toEqual(['s1', 's2'])
})

test('an unreadable session store shows an un-missable warning instead of looking like an empty project', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = join(userDataDir, storeName(project))
  writeFileSync(storeFile, '{"version":2,"activeId":"s1","sessions":[{"id":"s1","label":"Months of real work"')

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    await expect(
      win.getByText('Chats in this window will not be saved until that file can be read again', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 20_000 })
    // The copy claim is only honest when the copy landed; here it did, and the banner says so.
    await expect(win.getByText('Koda kept a copy of it beside the original', { exact: false })).toBeVisible()
  } finally {
    await app.close()
  }
})

/**
 * C1, and the highest-probability path in this whole change: schema drift after a downgrade hits ONE
 * row, so the store parses, the drifted chat is set aside, the load returns a SUCCESS, and the renderer
 * hydrates the short list. Saving is still on in this case, so the shortened list really is written back
 * — which makes this the one path where the file IS overwritten. It shipped saying nothing at all (the
 * reviewer booted it and got BANNER COUNT: 0, ON-DISK SESSIONS AFTER: ["s1"], and a chat simply gone).
 * Distinct wording from the total-failure banner on purpose: this project is otherwise working fine.
 */
test('a chat that drifted out of schema is reported to the user instead of vanishing quietly', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = join(userDataDir, storeName(project))
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 's1',
      sessions: [
        { id: 's1', label: 'Alpha project chat', cwd: project, items: [{ id: 1, kind: 'user', text: 'hello' }] },
        // Written by a newer build: an `approvalMode` this reader's enum doesn't have. Everything else
        // about the row is fine, which is exactly why only this row is lost.
        {
          id: 's2',
          label: 'Months of real work',
          cwd: project,
          items: [{ id: 2, kind: 'user', text: 'the work' }],
          approvalMode: 'not-a-real-enum-value',
        },
      ],
    }),
  )

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    // The user is TOLD, in chats rather than in filenames or row counts.
    await expect(win.getByText('Koda couldn’t read 1 chat in this project.', { exact: false })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.getByText('It was set aside instead of deleted', { exact: false })).toBeVisible()
    await expect(win.getByText('Koda kept a copy of the original file beside it', { exact: false })).toBeVisible()
    // …and the honest other half: unlike the total-failure case, this project still works and saves.
    await expect(win.locator('aside').getByText('Alpha project chat', { exact: true })).toBeVisible()
    await win.waitForTimeout(2000) // past the 500ms debounce, which does rewrite the shorter list
  } finally {
    await app.close()
  }

  // The drop is real (this is not a banner over a file that was left alone) — and the set-aside chat is
  // recoverable from the copy, which is the only reason the banner may say "instead of deleted".
  const saved = JSON.parse(readFileSync(storeFile, 'utf8'))
  expect(saved.sessions.map((s: { id: string }) => s.id)).toEqual(['s1'])
  const backups = readdirSync(userDataDir).filter((n) => n.startsWith(`${storeName(project)}.corrupt-`))
  expect(backups, 'no copy kept, so "set aside instead of deleted" would be a lie').toHaveLength(1)
  const kept = JSON.parse(readFileSync(join(userDataDir, backups[0]), 'utf8'))
  expect(kept.sessions.map((s: { id: string }) => s.id)).toEqual(['s1', 's2'])
})

test("archiving is blocked while this project's archive index cannot be read", async () => {
  const { project, userDataDir } = scratch()
  seedHealthyStore(userDataDir, project, 'Do not lose me')
  const indexFile = join(userDataDir, archiveName(project))
  const originalIndex = '{"version":2,"archived":[{"id":"a","label":"Last quarter","cwd":"/x","archivedAt":1}'
  writeFileSync(indexFile, originalIndex)

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    const row = win.locator('aside').getByText('Do not lose me', { exact: true })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(
      win.getByText('Archiving is turned off here until it can be read', {
        exact: false,
      }),
    ).toBeVisible()

    await row.click({ button: 'right' })
    await win.getByText('Archive session').click()

    // A blocked archive must leave the session exactly where it was — visible, still live — not
    // half-remove it from the hot list while failing to record it in the (unreadable) archive index.
    await expect(row).toBeVisible()
    await win.waitForTimeout(1500) // past the debounce, in case it half-wrote anyway
  } finally {
    await app.close()
  }

  expect(readFileSync(indexFile, 'utf8')).toBe(originalIndex)
  const saved = JSON.parse(readFileSync(join(userDataDir, storeName(project)), 'utf8'))
  expect(saved.sessions.map((s: { id: string }) => s.id)).toContain('s1')
})

/**
 * Backlog 23. The sibling of the test above, on the path desktop users actually click, and the one that
 * shipped broken: the index reads FINE, so nothing is blocked, and the archive proceeds — but the write
 * itself fails. Both halves of an archive used to go out on their own: the archived half over a
 * fire-and-forget `send` with no ack, the hot half on the 500ms debounce, which never fails the same
 * way. So a refused index write left the chat gone from the sidebar, absent from both stores, and its
 * transcript orphaned in `.bodies/` — silently, with a log line nobody reads.
 *
 * The write is failed by planting a DIRECTORY where atomic-write.ts wants its `<path>.tmp` scratch file,
 * which is EACCES/ENOSPC-shaped from `saveArchivedMeta`'s point of view and touches nothing else in
 * userData (the hot session store writes through its own differently-named tmp and keeps saving, which
 * is precisely the asymmetry that made this lossy).
 */
test('an archive whose index write is refused keeps the chat instead of losing it from both stores', async () => {
  const { project, userDataDir } = scratch()
  const storeFile = seedHealthyStore(userDataDir, project, 'Do not lose me either')
  // No index file at all — this project simply has nothing archived yet, so the read SUCCEEDS and none
  // of the load-failure guards apply. This test has to reach the write.
  const indexFile = join(userDataDir, archiveName(project))
  mkdirSync(`${indexFile}.tmp`)

  const app = await launchSeeded(project, userDataDir)
  try {
    const win = await app.firstWindow()
    const row = win.locator('aside').getByText('Do not lose me either', { exact: true })
    await expect(row).toBeVisible({ timeout: 20_000 })
    // Nothing is wrong yet, so nothing may be claimed yet.
    await expect(win.getByText('Koda couldn’t update this project’s archived chats.', { exact: false })).toHaveCount(0)

    await row.click({ button: 'right' })
    await win.getByText('Archive session').click()

    // Told, in what they see and do. Without this the click just appears to do nothing.
    await expect(
      win.getByText('Koda couldn’t update this project’s archived chats.', { exact: false }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(win.getByText('Nothing moved and nothing was lost', { exact: false })).toBeVisible()
    // Still in the sidebar, which is the promise the banner just made.
    await expect(row).toBeVisible()
    await win.waitForTimeout(2000) // well past the 500ms debounce that would have written the removal
  } finally {
    await app.close() // also fires the pre-quit flush, the other writer of the hot store
  }

  // Still on disk, in the store it never left.
  const saved = JSON.parse(readFileSync(storeFile, 'utf8'))
  expect(saved.sessions.map((s: { id: string }) => s.id)).toEqual(['s1'])
  expect(saved.sessions[0].label).toBe('Do not lose me either')
  // And not half-recorded on the other side: no index was created claiming an archive that never
  // happened.
  expect(existsSync(indexFile), 'an index exists, so the refused write did not actually fail').toBe(false)
  // Non-vacuity: the body file proves archiveSession really ran and got as far as the index write. A
  // typo'd menu item or a session that never archived would leave no body at all and make every
  // assertion above trivially true.
  const bodiesDir = `${indexFile.replace(/\.json$/, '')}.bodies`
  expect(
    existsSync(join(bodiesDir, bodyName('s1'))),
    'no transcript body was written, so the archive never reached the index write this test targets',
  ).toBe(true)
})

/**
 * The regression the write-refusal introduced, end to end. `koda-app-state.json` is the third store,
 * and unlike the two above it has no renderer to gate on, so its refusal lives in main. That made a torn
 * file PERMANENT: boot swallowed the throw and served an empty list, ProjectHome rendered a screen whose
 * text is identical to a fresh install, and the moment the user picked their project back the refusal
 * skipped the write, so the next launch was empty again. Forever, with the window size reset each time
 * and the phone's project list empty too.
 *
 * Two halves, one boot each:
 *   1. the user is TOLD, in a way a fresh install never says;
 *   2. the project they then open is still there after a restart.
 * Both matter on their own — telling the user about a dead end is still a dead end, and silently fixing
 * itself would leave them wondering where their list went.
 */
test('a project list that cannot be read says so, and the project opened after it survives a restart', async () => {
  const { project, userDataDir } = scratch()
  const stateFile = join(userDataDir, 'koda-app-state.json')
  // A torn write (the power-cut case the rest of this branch designs against), holding a real list.
  const original = '{"version":1,"openProjects":[],"recentProjects":["/Users/rb/Documents/every-project"'
  writeFileSync(stateFile, original)
  writeFileSync(join(userDataDir, 'koda-settings.json'), JSON.stringify({ hasOnboarded: true }))

  const first = await launchKoda({ userDataDir })
  try {
    const win = await first.firstWindow()
    // Empty openProjects ⇒ main opens ProjectHome. This is the screen that used to lie by omission.
    await expect(win.getByText('Open a project', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(win.getByText('Koda couldn’t read your list of projects.', { exact: false })).toBeVisible()
    await expect(
      win.getByText('Your projects are still on your Mac and nothing inside them has changed', {
        exact: false,
      }),
    ).toBeVisible()
    // The way out is promised only because the copy landed, and the promise has to be actionable.
    await expect(
      win.getByText('Open a project below and Koda will start the list again', { exact: false }),
    ).toBeVisible()

    // Take that way out. Playwright can't drive the native folder picker, so this calls the same
    // `project:open` handler the "Choose folder…" button hands the picked path to — everything after
    // the dialog is the real path, including main's noteProjectOpened write.
    await win.evaluate(
      (path) => (window as unknown as { koda: { openProject: (a: { path: string }) => Promise<unknown> } }).koda.openProject({ path }),
      project,
    )
    // The open was not a no-op: main took this window over as that project's window. The button path
    // swaps the renderer itself off the openProject result; the reload is how a test that skipped the
    // button asks main who this window is now.
    await win.reload()
    await expect(win.getByRole('button', { name: 'New chat' })).toBeVisible({ timeout: 20_000 })
    await win.waitForTimeout(2000)
  } finally {
    await first.close()
  }

  // Non-vacuity: the copy proves main actually read this file and failed on it.
  const backups = readdirSync(userDataDir).filter((n) => n.startsWith('koda-app-state.json.corrupt-'))
  expect(backups, 'no .corrupt backup — did main ever read the app state?').toHaveLength(1)
  expect(readFileSync(join(userDataDir, backups[0]), 'utf8')).toBe(original)

  // The list is rebuilt on disk rather than skipped. This is the assertion that fails on the shipped
  // behavior: the file was still the torn original, byte for byte, so the next launch is empty again.
  const savedText = readFileSync(stateFile, 'utf8')
  expect(savedText, 'the torn file survived the open, so the user re-picks this project every launch').not.toBe(
    original,
  )
  const saved = JSON.parse(savedText)
  expect(saved.recentProjects).toEqual([project])
  expect(saved.knownProjects).toEqual([project]) // the phone's Home list restarts with it

  // …and it sticks. A relaunch reopens the project instead of dead-ending on ProjectHome again.
  const second = await launchKoda({ userDataDir })
  try {
    const win = await second.firstWindow()
    await expect(win.getByRole('button', { name: 'New chat' })).toBeVisible({ timeout: 20_000 })
    // The notice was about a file that reads fine now, so it must be gone.
    await expect(win.getByText('Koda couldn’t read your list of projects.', { exact: false })).toHaveCount(0)
  } finally {
    await second.close()
  }
})
