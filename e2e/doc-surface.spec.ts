import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { launchKoda, makeUserDataDir, openFileViaLibrary } from './support/koda'

/**
 * Runtime confirmation for the WYSIWYG doc surface (Milkdown/Crepe): launches the BUILT app (so the
 * strict packaged CSP is applied — `isDev` is false), seeds app-state to boot straight into this
 * worktree as a project (avoids the native folder picker), opens README.md, and asserts the doc
 * renders with NO CSP violation — the one thing the static checks couldn't prove.
 */
const PROJECT_ROOT = process.cwd()
const sessionStoreName = (projectPath: string): string =>
  `koda-sessions-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`
const archiveStoreName = (projectPath: string): string =>
  `koda-archive-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`

/** The project's own shelf file: stars live with the work, not in Koda's userData (doc-commands.ts). */
const docShelfFile = (projectPath: string): string => join(projectPath, '.koda', 'doc-shelf.json')
const starredDocs = (projectPath: string): string[] => {
  try {
    return (JSON.parse(readFileSync(docShelfFile(projectPath), 'utf8')) as { starred?: string[] }).starred ?? []
  } catch {
    return [] // not written yet, or mid-write — the poll below simply keeps waiting
  }
}

// Boot the built app straight into `projectPath` (seeds app-state, dodging the native folder picker).
const launchSeeded = (projectPath: string) => launchKoda({ projectPath })

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

    // The rail no longer browses files at all, so this waits on the rail's own button and reaches the
    // file through Find below.
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    // Files moved out of the rail, so the Library (⌘P/⌘K) is the file-opening path now. Typing the
    // name and taking its Project files row is what a user does; it exercises the same `openFile`
    // seam the tree used to call.
    await openFileViaLibrary(win, 'README.md')

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

test('closing an edited document flushes its last text before the tab disappears', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-close-')))
  const filename = 'close-flush.md'
  const path = join(project, filename)
  writeFileSync(path, '# Close flush\n\nOriginal body.\n')
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, filename)

    const prose = win.locator('.milkdown .ProseMirror')
    await expect(prose).toBeVisible({ timeout: 20_000 })
    await win.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(prose).toHaveAttribute('contenteditable', 'true')
    await prose.locator('p').last().click()
    await win.keyboard.press('End')
    await win.keyboard.press('Enter')
    await win.keyboard.type('Kept by closing.')

    // Close well inside the 900ms idle-save window. The unmount flush, not the trailing timer, must
    // put the last line on disk before this surface can be opened again.
    expect(readFileSync(path, 'utf8')).not.toContain('Kept by closing.')
    await win.getByRole('button', { name: `Close ${filename}` }).click()
    await expect
      .poll(() => readFileSync(path, 'utf8'), { timeout: 5_000 })
      .toContain('Kept by closing.')

    await openFileViaLibrary(win, filename)
    await expect(prose).toContainText('Kept by closing.', { timeout: 20_000 })
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})

/**
 * The Library replaced the Documents pane, and the pane it replaced had runtime coverage here. This is
 * that coverage moved rather than dropped, and it proves the parts static checks cannot: the ⌘K
 * binding survives the packaged build, `library:query` answers over real IPC, rows carry AUTHORED
 * TITLES instead of filenames (the whole "documents, not files" claim), and Enter hands the path to
 * the Stage. Run against this worktree, whose `Documents/` corpus is the fixture.
 *
 * It deliberately runs with NO CHAT. A star describes the person's relationship to a project
 * document, not to whichever conversation happens to be open; the control and the resulting sidebar
 * shortcut therefore have to work before the first chat and after the last one closes. Relaunching the
 * same disposable profile proves the choice reached the project store instead of transient UI state.
 */
test('the Library stars without a chat, hands the document to the Stage, and restores the star on relaunch', async () => {
  const userDataDir = makeUserDataDir('koda-doc-lib-e2e-')
  // This one runs against the worktree itself, so leave its shelf as we found it.
  const shelfBefore = existsSync(docShelfFile(PROJECT_ROOT))
    ? readFileSync(docShelfFile(PROJECT_ROOT), 'utf8')
    : null
  // The filename main derives for a project's sessions: sha256 of the root, first 16 hex. Start with a
  // real but empty v3 store so the first assertion covers the exact no-session state from the report.
  const storeFile = join(userDataDir, sessionStoreName(PROJECT_ROOT))
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: PROJECT_ROOT,
      activeId: null,
      sessions: [],
      starredDocs: [],
      legacyKeptDocsImported: [],
    }),
  )
  let app = await launchKoda({ projectPath: PROJECT_ROOT, userDataDir })
  const pageErrors: string[] = []
  try {
    let win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    // ControlOrMeta so this reads the same on the Linux worker as on a Mac — the binding accepts either.
    await win.keyboard.press('ControlOrMeta+k')
    const library = win.getByRole('dialog', { name: 'Library' })
    await expect(library).toBeVisible({ timeout: 20_000 })

    // The authored title, not `document-workspace.md`. A row showing the filename would mean the
    // frontmatter substrate never reached the surface it exists for.
    await library.getByRole('combobox', { name: 'Find a document' }).fill('document workspace')
    const row = library.getByRole('option', { name: /The Document Workspace/ })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()

    // Starring is offered without a chat, and the same preview immediately reflects the new state.
    await library.getByRole('button', { name: 'Star' }).click()
    await expect(library.getByRole('button', { name: 'Unstar' })).toBeVisible({ timeout: 10_000 })
    await expect(win.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(win.getByRole('button', { name: 'The Document Workspace', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // The star landed in the PROJECT's shelf, which is what makes it survive the folder being moved —
    // the sessions store is named after where the project used to be.
    await expect
      .poll(() => starredDocs(PROJECT_ROOT), { timeout: 10_000 })
      .toContain('Documents/architecture/document-workspace.md')

    await library.getByRole('button', { name: 'Open document' }).click()
    await expect(library).toBeHidden({ timeout: 10_000 })
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })

    await app.close()
    app = await launchKoda({ projectPath: PROJECT_ROOT, userDataDir })
    win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    await expect(win.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('button', { name: 'The Document Workspace', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    if (shelfBefore === null) rmSync(docShelfFile(PROJECT_ROOT), { force: true })
    else writeFileSync(docShelfFile(PROJECT_ROOT), shelfBefore)
  }
})

test('the Stage bar stars the open document and the shelf follows without a Library trip', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-stagestar-')))
  writeFileSync(join(project, 'Reading notes.md'), '# Reading notes\n\nBody.\n')
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, 'Reading notes.md')
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })

    // The star sits in the Stage bar itself: keeping the document you are reading must not require a
    // trip back through the Library.
    const star = win.getByRole('button', { name: 'Star this document' })
    await expect(star).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 })
    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'true')
    await expect(win.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible({ timeout: 10_000 })
    // Scoped to the shelf section, exact name: the Stage tab, its close control, and the row's own
    // actions menu all carry the same document name.
    const shelf = win.locator('section[aria-labelledby="documents-shelf-heading"]')
    await expect(shelf.getByRole('button', { name: 'Reading notes', exact: true })).toBeVisible({ timeout: 20_000 })

    // The same control unstars. The row leaves, while the named section keeps the Library action
    // reachable even when the project has no shortcuts yet.
    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'false')
    await expect(win.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(shelf.getByRole('button', { name: 'Reading notes', exact: true })).toHaveCount(0)

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})

/**
 * The open document's overflow menu, after RB's redesign: the ••• no longer repeats Star — the star
 * button sitting right beside it owns that toggle. Instead the menu holds the pin-backed Hold view
 * toggle plus the project-owned actions that otherwise force a trip back through the Library (Reveal
 * in Finder, Copy path, and a recoverable Delete), and stays reachable by keyboard with Escape
 * returning focus to its trigger. Delete is only asserted present here, never invoked, so the
 * worktree's own documents are untouched.
 */
test('the Stage bar overflow menu offers the Library actions without Star, reachable by keyboard', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-stagemenu-')))
  writeFileSync(join(project, 'Overflow notes.md'), '# Overflow notes\n\nBody.\n')
  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, 'Overflow notes.md')
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })

    // Star from the BUTTON beside the menu — that button owns the toggle, which is exactly why the menu
    // no longer repeats it. The shelf follows without a Library trip.
    const star = win.getByRole('button', { name: 'Star this document' })
    await expect(star).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 })
    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'true')
    const shelf = win.locator('section[aria-labelledby="documents-shelf-heading"]')
    await expect(shelf.getByRole('button', { name: 'Overflow notes', exact: true })).toBeVisible({ timeout: 20_000 })

    // Open the ••• menu from the keyboard: focus its trigger and press Enter. Opening it moves focus onto
    // Hold view, the first action, so the menu is reachable without a pointer.
    const trigger = win.getByRole('button', { name: 'More document actions' })
    await trigger.focus()
    await win.keyboard.press('Enter')
    const menu = win.getByRole('menu', { name: 'Document actions' })
    await expect(menu).toBeVisible({ timeout: 10_000 })
    const hold = menu.getByRole('menuitemcheckbox', { name: 'Hold view', exact: true })
    await expect(hold).toBeFocused()
    await expect(hold).toHaveAttribute('aria-checked', 'false')

    // The remaining item set stays the Library's document actions, and NOT Star/Unstar — the star
    // toggle is the button beside the trigger, so putting it here too would be redundant.
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
      'Reveal in Finder',
      'Copy path',
      'Delete…',
    ])
    await expect(menu.getByRole('menuitem', { name: 'Star' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: 'Unstar' })).toHaveCount(0)

    // Holding closes the menu and leaves the pin beside the active document title as the persistent
    // state. Reopening exposes the same state through the checked menu item.
    await hold.click()
    await expect(menu).toBeHidden()
    await expect(win.getByRole('img', { name: 'View held' })).toBeVisible()
    await trigger.click()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Hold view', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    // Escape closes the menu and returns focus to the trigger.
    await win.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('the sidebar separates Sessions, Starred documents, and History while keeping every action reachable', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-shelf-')))
  // Keep this profile name short: Chromium creates a Unix-domain SingletonSocket below TMPDIR, and
  // the Lab job prefix already consumes most of Linux's 108-byte sockaddr_un path budget.
  const userDataDir = makeUserDataDir('koda-ds-')
  const documentPath = join(project, 'brief.md')
  const nestedDir = join(project, 'Documents')
  const nestedPath = join(nestedDir, 'sidebar-details.md')
  const longLivedRel = 'Documents/long-lived-star.md'
  const longLivedPath = join(project, longLivedRel)
  mkdirSync(nestedDir, { recursive: true })
  writeFileSync(longLivedPath, '---\ntitle: Long-lived star\nkind: note\n---\n\n# Long-lived star\n')
  const oldStar = new Date('2001-01-01T00:00:00.000Z')
  const oldFiller = new Date('2002-01-01T00:00:00.000Z')
  utimesSync(longLivedPath, oldStar, oldStar)
  // Put the existing star beyond the Library's 300-row browse cap. Its shelf row must come from the
  // exact resolver, not from whichever recent documents happened to make the capped result.
  for (let i = 0; i < 301; i += 1) {
    const filler = join(nestedDir, `filler-${String(i).padStart(3, '0')}.md`)
    writeFileSync(filler, `# Filler ${i}\n`)
    utimesSync(filler, oldFiller, oldFiller)
  }
  // This is deliberately ignored by the project's Git. Delete still has to capture the exact latest
  // bytes in Koda's separate recovery store before it removes anything.
  writeFileSync(join(project, '.gitignore'), 'brief.md\n')
  writeFileSync(
    documentPath,
    [
      '---',
      'title: Brief',
      'description: A small document for the sidebar action flow.',
      'kind: note',
      '---',
      '',
      '# Brief',
      '',
      'A document worth keeping close.',
      '',
    ].join('\n'),
  )
  writeFileSync(
    nestedPath,
    [
      '---',
      'title: Sidebar details',
      'kind: note',
      '---',
      '',
      '# Sidebar details',
      '',
      'Useful path context.',
      '',
    ].join('\n'),
  )
  // Seeded in the PRE-shelf shape on purpose: this store is the legacy source, so the run also proves
  // an upgrading project's existing star arrives on the project shelf without the user doing anything.
  const storeFile = join(userDataDir, sessionStoreName(project))
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'document-sidebar-session',
      sessions: [
        {
          id: 'document-sidebar-session',
          label: 'Document sidebar session',
          cwd: project,
          items: [{ id: 1, kind: 'user', text: 'Finish the document sidebar.' }],
        },
      ],
      starredDocs: [longLivedRel],
      legacyKeptDocsImported: [],
    }),
  )
  writeFileSync(
    join(userDataDir, archiveStoreName(project)),
    JSON.stringify({
      version: 2,
      archived: [
        {
          id: 'document-sidebar-archive',
          label: 'Earlier document work',
          cwd: project,
          archivedAt: Date.now() - 60_000,
        },
      ],
    }),
  )
  const scratchDir = join(project, '.koda', 'scratch')
  mkdirSync(scratchDir, { recursive: true })
  writeFileSync(
    join(scratchDir, 'image-sidebar-fixture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )

  let app = await launchKoda({ projectPath: project, userDataDir })
  const pageErrors: string[] = []
  try {
    let win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    const longLivedRow = win.getByRole('button', { name: 'Long-lived star', exact: true })
    await expect(longLivedRow).toHaveAttribute('aria-disabled', 'false', { timeout: 20_000 })
    // The pre-shelf star reached the project shelf on its own, which is the whole migration in one line.
    await expect.poll(() => starredDocs(project), { timeout: 10_000 }).toContain(longLivedRel)
    await longLivedRow.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Unstar', exact: true }).click()
    await expect(longLivedRow).toBeHidden()

    const starDocument = async (query: string, name: RegExp): Promise<void> => {
      await win.keyboard.press('ControlOrMeta+k')
      const library = win.getByRole('dialog', { name: 'Library' })
      await expect(library).toBeVisible({ timeout: 20_000 })
      await library.getByRole('combobox', { name: 'Find a document' }).fill(query)
      // Scoped to the Documents section: the merged Library also lists project files below, and a
      // file's content hits can echo the same title this regex is looking for.
      const result = library.getByRole('group', { name: 'Documents' }).getByRole('option', { name })
      await expect(result).toBeVisible({ timeout: 20_000 })
      await result.click()
      await library.getByRole('button', { name: 'Star', exact: true }).click()
      await win.keyboard.press('Escape')
      await expect(library).toBeHidden({ timeout: 10_000 })
    }

    await starDocument('brief', /Brief/)
    const aside = win.locator('aside')
    const sessionsSection = aside.locator('section[aria-labelledby="sessions-heading"]')
    const starredSection = aside.locator('section[aria-labelledby="documents-shelf-heading"]')
    const historySection = aside.locator('section[aria-labelledby="history-heading"]')
    const sessionsHeading = aside.getByRole('heading', { name: 'Sessions', exact: true })
    const documentsHeading = starredSection.getByRole('heading', { name: 'Starred documents', exact: true })
    const historyHeading = historySection.getByRole('heading', { name: 'History', exact: true })
    await expect(sessionsSection).toBeVisible()
    await expect(sessionsHeading).toBeVisible()
    await expect(documentsHeading).toBeVisible()
    await expect(historyHeading).toBeVisible()
    await expect(aside.getByRole('heading', { name: 'Active', exact: true })).toHaveCount(0)
    const projectName = basename(project)
    await expect(win.locator('.app-drag').getByText(projectName, { exact: false })).toBeVisible()
    await expect(aside.getByText(projectName, { exact: true })).toHaveCount(0)
    let row = win.getByRole('button', { name: 'Brief', exact: true })
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('aria-disabled', 'false')

    // This is the original visual regression: DOM order already looked right while flex growth left a
    // screenful of empty space before Documents. The real boxes must now touch as one navigation flow.
    const sessionRow = aside.getByText('Document sidebar session', { exact: true })
    const sessionBox = await sessionRow.boundingBox()
    const documentsBox = await documentsHeading.boundingBox()
    expect(sessionBox).not.toBeNull()
    expect(documentsBox).not.toBeNull()
    const sectionGap = documentsBox!.y - (sessionBox!.y + sessionBox!.height)
    expect(sectionGap).toBeGreaterThanOrEqual(0)
    expect(sectionGap).toBeLessThan(56)
    const archivedUtility = historySection.getByRole('button', { name: 'Archived chats (1)' })
    const recentUtility = historySection.getByRole('button', { name: 'Recent images (1)' })
    await expect(archivedUtility).toBeVisible()
    await expect(recentUtility).toBeVisible()
    await expect(archivedUtility.locator('svg')).toHaveCount(0)
    await expect(recentUtility.locator('svg')).toHaveCount(0)
    const archivedBox = await archivedUtility.boundingBox()
    const recentBox = await recentUtility.boundingBox()
    const asideBox = await aside.boundingBox()
    expect(archivedBox!.y).toBeGreaterThan(documentsBox!.y)
    expect(recentBox!.y).toBeGreaterThan(archivedBox!.y)
    const historyBottomGap = asideBox!.y + asideBox!.height - (recentBox!.y + recentBox!.height)
    expect(historyBottomGap).toBeGreaterThanOrEqual(8)
    expect(historyBottomGap).toBeLessThanOrEqual(32)

    // History remains navigation, not global chrome. Its rows disclose anchored cards beside the rail,
    // and the global destinations stay in the window footer below it.
    await expect(aside.getByRole('button', { name: /^Versions/ })).toHaveCount(0)
    await expect(aside.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)
    const footer = win.locator('footer')
    await expect(footer.getByRole('button', { name: /^Versions/ })).toBeVisible()
    await expect(footer.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

    await archivedUtility.focus()
    const archivedCard = win.locator('[aria-label="Archived chats"]')
    await expect(archivedCard).toBeVisible()
    const archivedCardBox = await archivedCard.boundingBox()
    expect(archivedCardBox!.x).toBeGreaterThan(archivedBox!.x + archivedBox!.width)
    await win.keyboard.press('Tab')
    await expect(win.getByRole('button', { name: 'Restore Earlier document work' })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(archivedCard).toBeHidden()
    await expect(archivedUtility).toBeFocused()

    await recentUtility.focus()
    await expect(win.getByRole('button', { name: 'View image-sidebar-fixture.png' })).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(recentUtility).toBeFocused()

    // Archive is an action, not a completed-state signal: it stays a quiet word on row hover.
    await sessionRow.hover()
    const archiveAction = aside.getByRole('button', { name: 'Archive', exact: true })
    await expect(archiveAction).toBeVisible()
    await expect(archiveAction.locator('svg')).toHaveCount(0)

    // Shelf membership already carries the starred state, so the row itself has no repeated star.
    await expect(row.locator('svg')).toHaveCount(0)
    // A root-equivalent title gets no hover card that merely repeats `brief.md` back to the user.
    await row.hover()
    await win.waitForTimeout(700)
    await expect(win.getByRole('tooltip')).toHaveCount(0)

    const actions = win.getByRole('button', { name: 'Actions for Brief', exact: true })
    await win.mouse.move(700, 160)
    await expect(actions).toHaveCSS('opacity', '0')
    await row.focus()
    await expect(actions).toHaveCSS('opacity', '1')
    await actions.focus()
    await win.keyboard.press('Enter')
    let menu = win.getByRole('menu', { name: 'Actions for Brief' })
    await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
    const expectedActions = ['Open', 'Reveal in Finder', 'Unstar', 'Delete document…']
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(expectedActions)
    await win.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Reveal in Finder', exact: true })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(actions).toBeFocused()

    // The overflow and right-click routes are one menu, not two drifting command lists.
    await row.click({ button: 'right' })
    menu = win.getByRole('menu', { name: 'Actions for Brief' })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(expectedActions)
    await menu.getByRole('menuitem', { name: 'Open', exact: true }).click()
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })

    await row.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Unstar', exact: true }).click()
    await expect(row).toBeHidden()
    expect(existsSync(documentPath)).toBe(true)

    await starDocument('brief', /Brief/)
    row = win.getByRole('button', { name: 'Brief', exact: true })
    await expect(row).toHaveAttribute('aria-disabled', 'false')
    await starDocument('sidebar details', /Sidebar details/)
    const nestedRow = win.getByRole('button', { name: 'Sidebar details', exact: true })
    await expect(nestedRow).toHaveAttribute('aria-disabled', 'false')
    await nestedRow.hover()
    await expect(win.getByRole('tooltip')).toContainText('Documents/sidebar-details.md', {
      timeout: 5_000,
    })
    const nestedActions = win.getByRole('button', { name: 'Actions for Sidebar details', exact: true })
    await nestedActions.click()
    await expect(win.getByRole('tooltip')).toHaveCount(0)
    await win.keyboard.press('Escape')

    // A disappeared shortcut remains removable, but path-dependent commands are not offered against a
    // synthesized absolute path.
    rmSync(nestedPath)
    // Once the authored frontmatter is gone the retained shortcut falls back to its filename-derived
    // title, whose capitalization may differ. Follow the same row by meaning, not stale display text.
    const staleRow = win.getByRole('button', { name: /^sidebar details$/i })
    await expect(staleRow).toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 })
    const staleActions = win.getByRole('button', { name: /^Actions for sidebar details$/i })
    await staleActions.click()
    const staleMenu = win.getByRole('menu', { name: /^Actions for sidebar details$/i })
    expect(await staleMenu.getByRole('menuitem').allTextContents()).toEqual(['Unstar'])
    await staleMenu.getByRole('menuitem', { name: 'Unstar', exact: true }).click()
    await expect(staleRow).toBeHidden()

    // Confirmation defaults to the safe choice, traps focus, and Escape leaves both file and shortcut.
    await row.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Delete document…', exact: true }).click()
    let confirm = win.getByRole('dialog', { name: /Delete.*Brief/ })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await win.keyboard.press('Shift+Tab')
    await expect(confirm.getByRole('button', { name: 'Delete document', exact: true })).toBeFocused()
    await win.keyboard.press('Tab')
    await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect(row).toBeFocused()
    expect(existsSync(documentPath)).toBe(true)

    // Delete immediately after typing. The editor registry must flush before main checkpoints this
    // ignored document; the delete point therefore contains the final line, not the older disk body.
    const prose = win.locator('.milkdown .ProseMirror')
    await win.getByRole('button', { name: 'Edit', exact: true }).click()
    await prose.locator('p').last().click()
    await win.keyboard.press('End')
    await win.keyboard.press('Enter')
    const finalLine = 'Latest line before recoverable delete.'
    await win.keyboard.type(finalLine)
    expect(readFileSync(documentPath, 'utf8')).not.toContain(finalLine)

    await row.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Delete document…', exact: true }).click()
    confirm = win.getByRole('dialog', { name: /Delete.*Brief/ })
    await confirm.getByRole('button', { name: 'Delete document', exact: true }).click()
    await expect.poll(() => existsSync(documentPath), { timeout: 10_000 }).toBe(false)
    await expect(row).toBeHidden()
    await expect(documentsHeading).toBeVisible()
    await expect(win.getByRole('button', { name: 'Close brief.md' })).toBeHidden()
    await win.waitForTimeout(1_200)
    expect(existsSync(documentPath)).toBe(false)

    const recovery = await win.evaluate(async (path) => {
      const checkpoints = await window.koda.listCheckpoints()
      const latest = checkpoints[0]
      if (!latest) return null
      const diff = await window.koda.checkpointFileDiff({ checkpointId: latest.id, path })
      return { id: latest.id, diff }
    }, 'brief.md')
    expect(recovery).not.toBeNull()
    expect(recovery!.diff.before).toContain(finalLine)
    expect(recovery!.diff.after).toBe('')
    await win.evaluate(
      (checkpointId) => window.koda.restoreCheckpoint({ checkpointId }),
      recovery!.id,
    )
    await expect.poll(() => readFileSync(documentPath, 'utf8'), { timeout: 10_000 }).toContain(finalLine)

    // The shelf lives in the project and is checkpointed with the documents it describes, so the
    // recovery that brought the document back brought its shortcut back too — the shelf and the files
    // it points at are rewound as one thing, and neither is left describing a state the other is not in.
    await expect.poll(() => starredDocs(project), { timeout: 10_000 }).toContain('brief.md')
    await expect(win.getByRole('button', { name: 'Brief', exact: true })).toBeVisible({ timeout: 10_000 })

    await app.close()
    app = await launchKoda({ projectPath: project, userDataDir })
    win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    await expect(win.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('button', { name: 'Brief', exact: true })).toBeVisible({ timeout: 20_000 })
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

/**
 * A recognized relative link to a project-local artifact renders as a smart card (typed-documents
 * plan, Slice 2 + Architecture §5). This seeds the link and its sibling `.html` so it is deterministic:
 * the card must appear, opening it must co-open the artifact BESIDE the source (not replace it), and the
 * source `.md` must stay byte-for-byte the portable markdown it was — the card is presentation only.
 */
test('a relative artifact link renders as a smart card, opens beside the source, and never rewrites the file', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-card-')))
  const docsDir = join(project, 'Documents')
  mkdirSync(docsDir, { recursive: true })
  const guidePath = join(docsDir, 'guide.md')
  const guideBytes = [
    '---',
    'title: Growing guide',
    'kind: guide',
    '---',
    '',
    '# Growing guide',
    '',
    'Notes about the season.',
    '',
    '[Frost explorer](frost.html)',
    '',
  ].join('\n')
  writeFileSync(guidePath, guideBytes)
  writeFileSync(
    join(docsDir, 'frost.html'),
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8" /><title>Frost explorer</title></head>',
      '<body><h1>Frost explorer</h1><p>Interactive artifact.</p></body></html>',
      '',
    ].join('\n'),
  )

  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, 'guide.md')

    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })
    // The lone artifact link became a card; the raw markdown link is not shown as plain body text.
    const card = win.locator('.milkdown .ProseMirror p.koda-artifact-card')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('a')).toHaveText('Frost explorer')

    // Opening the card co-opens the artifact BESIDE the source: the HTML document frame appears and the
    // source tab's close control is still present.
    await card.locator('a').click()
    await expect(win.locator('iframe[data-html-document-frame]')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('button', { name: 'Close guide.md' })).toBeVisible({ timeout: 10_000 })

    // The whole point of §5: the file on disk is untouched portable markdown, not a card node.
    expect(readFileSync(guidePath, 'utf8')).toBe(guideBytes)
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})

/**
 * The full Create-interactive-view flow (plan "Turn part of a document into a richer view"): select a
 * passage, run the action, and Koda carves a sibling HTML artifact, drops an ordinary relative link
 * back into the source, renders it as a card, and opens the artifact beside the source. The on-disk
 * source stays plain markdown — the create command writes exactly one file and the link is portable.
 */
test('Create interactive view carves a sibling HTML, links back portably, and opens it beside the source', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-mkview-')))
  const docsDir = join(project, 'Documents')
  mkdirSync(docsDir, { recursive: true })
  const guidePath = join(docsDir, 'guide.md')
  writeFileSync(guidePath, ['# Growing guide', '', 'Frost explorer', ''].join('\n'))
  const htmlSiblings = (): string[] => {
    try {
      return readdirSync(docsDir).filter((name) => name.toLowerCase().endsWith('.html'))
    } catch {
      return []
    }
  }

  const app = await launchSeeded(project)
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, 'guide.md')

    const prose = win.locator('.milkdown .ProseMirror')
    await expect(prose).toBeVisible({ timeout: 20_000 })
    // Edit mode guarantees the selection toolbar; the passage becomes the artifact's seed and title.
    await win.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(prose).toHaveAttribute('contenteditable', 'true')
    const passage = prose.locator('p', { hasText: 'Frost explorer' })
    await passage.click({ clickCount: 3 })

    // Crepe's formatting toolbar carries Koda's action as its last item; opening it reveals the bubble.
    const toolbar = win.locator('.milkdown-toolbar[data-show="true"]')
    await expect(toolbar).toBeVisible({ timeout: 10_000 })
    // Koda's selection capture only freezes the passage while that toolbar is up (it reads its
    // geometry). A no-op modifier keyup, now that the toolbar is visible, re-runs the capture without
    // changing the selection, so the passage is frozen before the sparkle opens the bubble.
    await win.keyboard.press('Shift')
    await win.waitForTimeout(100)
    await toolbar.locator('.toolbar-item').last().click()
    const makeView = win.getByRole('button', { name: /interactive view/i })
    await expect(makeView).toBeVisible({ timeout: 10_000 })
    await makeView.click()

    // A sibling HTML artifact was created under Documents/.
    await expect.poll(htmlSiblings, { timeout: 15_000 }).not.toHaveLength(0)
    // It opened beside the source: the document frame is up and the source tab is still there.
    await expect(win.locator('iframe[data-html-document-frame]')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByRole('button', { name: 'Close guide.md' })).toBeVisible({ timeout: 10_000 })

    // The source now carries an ordinary relative markdown link to the artifact — not raw HTML.
    await expect
      .poll(() => readFileSync(guidePath, 'utf8'), { timeout: 15_000 })
      .toMatch(/\]\([^)]*\.html\)/)
    const source = readFileSync(guidePath, 'utf8')
    expect(source).not.toContain('<a ')
    expect(source).not.toContain('<div')
    expect(source).not.toContain('data-koda-artifact')

    // Re-activate the source tab (it stayed open beside the artifact): the inserted link now shows as a
    // smart card in the same editor that carved the view.
    const sourceTab = win.locator(`[data-staged][title="${guidePath}"]`)
    await sourceTab.click()
    await expect(sourceTab).toHaveAttribute('data-staged', 'true')
    await expect(win.locator('.milkdown .ProseMirror p.koda-artifact-card')).toBeVisible({ timeout: 20_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('New document in the Library creates a document and opens it in the editor', async () => {
  // Isolated temp project so the created file is auto-discarded with the temp dir.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-proj-')))
  const app = await launchSeeded(project)
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    await win.keyboard.press('ControlOrMeta+k')
    const library = win.getByRole('dialog', { name: 'Library' })
    await expect(library).toBeVisible({ timeout: 20_000 })
    const newDoc = library.getByRole('button', { name: 'New document', exact: true })
    await newDoc.waitFor({ timeout: 20_000 })
    await newDoc.click()

    await expect(library).toBeHidden({ timeout: 10_000 })
    await expect.poll(() => existsSync(join(project, 'Documents', 'Untitled.md'))).toBe(true)
    // The new doc opens in the WYSIWYG editor and is not automatically starred.
    await expect(win.locator('.milkdown .ProseMirror')).toBeVisible({ timeout: 20_000 })
    const shelf = win.locator('section[aria-labelledby="documents-shelf-heading"]')
    await expect(shelf.getByRole('heading', { name: 'Starred documents', exact: true })).toBeVisible()
    await expect(shelf.getByRole('button', { name: 'Untitled', exact: true })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
