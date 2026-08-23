import { test, expect, type FrameLocator, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, openFileViaLibrary } from './support/koda'

/**
 * Runtime proof for the sandboxed HTML document surface (typed-documents plan, Slice 1). Launches the
 * BUILT app so the packaged CSP and the real `koda-preview://` protocol handler are in play, opens the
 * committed fixtures from a disposable project, and asks the two questions static checks cannot:
 *
 * 1. does a self-contained document actually RUN — its own script, its own interaction, refreshed when
 *    the file changes underneath it; and
 * 2. does a hostile one get NOTHING — no network, no Node, no IPC, no other file, no way out of the
 *    frame — while Koda stays exactly where it was.
 */
const FIXTURES = join(process.cwd(), 'e2e', 'fixtures', 'documents')

// Fixtures land at the project ROOT, which is where the Find overlay's file row shows only the
// filename (a nested file adds its folder to the row's accessible name, so an exact-name lookup would
// miss it — the existing doc specs open root files for the same reason). The document surface and the
// star command are both format-blind about location, so root is a faithful place to prove them.
function seedProject(prefix: string, fixtures: string[]): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  for (const name of fixtures) copyFileSync(join(FIXTURES, name), join(project, name))
  return project
}


const documentFrame = (win: Page): FrameLocator => win.frameLocator('iframe[data-html-document-frame]')

test('an HTML document opens on the Stage, runs, stars, and follows the file on disk', async () => {
  // Past the 30s project default: this one walk covers a cold app launch, the document frame, the lazy
  // Monaco chunk behind the source toggle, and a watcher-driven refresh.
  test.setTimeout(120_000)
  const project = seedProject('koda-html-doc-', ['interactive-report.html'])
  const documentPath = join(project, 'interactive-report.html')
  const app = await launchKoda({ projectPath: project })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await openFileViaLibrary(win, 'interactive-report.html')

    // The document's OWN script ran: every one of these values is computed at runtime from the inline
    // data, so asserting them is asserting that scripts execute inside the sandbox. A static render of
    // the markup would leave the readout and the table body empty.
    const frame = documentFrame(win)
    await expect(frame.locator('#frost-out')).toHaveText('Apr 3', { timeout: 20_000 })
    await expect(frame.locator('#rows tr')).toHaveCount(4)
    await expect(frame.locator('#rows tr').first().locator('td').nth(1)).toHaveText('Feb 6')
    await expect(frame.locator('#note')).toContainText('4 of 4 trays committed')

    // Interaction, not just first paint: the toggle rewrites the same cells on click.
    await frame.locator('#units').click()
    await expect(frame.locator('#rows tr').first().locator('td').nth(1)).toHaveText('8 weeks out')

    // Isolated origin: Koda's renderer cannot reach into the document it is showing.
    const reach = await win.evaluate(() => {
      const frameEl = document.querySelector('iframe[data-html-document-frame]') as HTMLIFrameElement | null
      if (!frameEl) return 'missing'
      try {
        return frameEl.contentDocument ? 'reachable' : 'opaque'
      } catch {
        return 'threw'
      }
    })
    expect(reach).not.toBe('reachable')

    // Stage chrome parity: the star is the same project-owned command a Markdown document gets, and it
    // reaches the project shelf on disk without a trip through the Library.
    const star = win.getByRole('button', { name: 'Star this document' })
    await expect(star).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 })
    await star.click()
    await expect(star).toHaveAttribute('aria-pressed', 'true')
    await expect
      .poll(
        () => {
          try {
            return JSON.parse(readFileSync(join(project, '.koda', 'doc-shelf.json'), 'utf8')).starred ?? []
          } catch {
            return []
          }
        },
        { timeout: 10_000 },
      )
      .toContain('interactive-report.html')

    // The labelled current-view control keeps source and diff available without permanently spending
    // three buttons on the Stage bar. Choosing source updates that same trigger, and Page comes back.
    const pageView = win.getByRole('button', { name: 'Page', exact: true })
    await pageView.focus()
    await pageView.press('Enter')
    const viewMenu = win.getByRole('menu', { name: 'Document view' })
    await expect(viewMenu.getByRole('menuitemradio', { name: 'Page', exact: true })).toBeFocused()
    await win.keyboard.press('ArrowDown')
    await expect(viewMenu.getByRole('menuitemradio', { name: 'HTML', exact: true })).toBeFocused()
    await win.keyboard.press('Enter')
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
    const htmlView = win.getByRole('button', { name: 'HTML', exact: true })
    await expect(htmlView).toBeFocused()
    await htmlView.press('Enter')
    await expect(viewMenu.getByRole('menuitemradio', { name: 'HTML', exact: true })).toBeFocused()
    await win.keyboard.press('Home')
    await expect(viewMenu.getByRole('menuitemradio', { name: 'Page', exact: true })).toBeFocused()
    await win.keyboard.press('Enter')
    await expect(frame.locator('#frost-out')).toHaveText('Apr 3', { timeout: 20_000 })

    // Tab dismisses the popup and continues through the toolbar instead of trapping focus in a
    // portaled menu. Star is the next control after the view chooser.
    await expect(pageView).toBeFocused()
    await pageView.press('Enter')
    await win.keyboard.press('Tab')
    await expect(viewMenu).toBeHidden()
    await expect(star).toBeFocused()

    // An external edit — the shape an agent rewrite takes on disk — refreshes the surface through the
    // existing narrow watcher. No reopen, no manual reload.
    writeFileSync(
      documentPath,
      '<!doctype html><html><body><h1 id="edited">Rewritten by an outside edit</h1>' +
        '<script>document.getElementById("edited").textContent = "Rewritten and re-run"</script></body></html>',
    )
    await expect(documentFrame(win).locator('#edited')).toHaveText('Rewritten and re-run', { timeout: 20_000 })

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('the hostile document reaches nothing and leaves Koda where it was', async () => {
  // The fixture's slowest probe gives an external pixel 4s to fail before it settles; the rest is a
  // cold app launch.
  test.setTimeout(90_000)
  const project = seedProject('koda-html-hostile-', ['hostile.html'])
  // A file the document must never be able to read. It is inside the project, so nothing but the
  // document origin's own allowlist stands between a probe and these bytes.
  writeFileSync(join(project, 'not-for-the-document.txt'), 'PRIVATE-CANARY-VALUE')
  const app = await launchKoda({ projectPath: project })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => pageErrors.push(e.message))
    // The self-navigation escape (probe 8) would show up as the document frame committing to a
    // koda-preview host WITHOUT the `doc-` prefix (the permissive app-preview origin) and, on that
    // no-CSP page, a real outbound response arriving. Record both to prove neither happened.
    const previewFrameNavigations: string[] = []
    win.on('framenavigated', (frame) => {
      const u = frame.url()
      if (u.startsWith('koda-preview://')) previewFrameNavigations.push(u)
    })
    const externalResponses: string[] = []
    win.on('response', (resp) => {
      const u = resp.url()
      if (!/^(?:koda-preview:|file:|https?:\/\/(?:localhost|127\.0\.0\.1))/.test(u))
        externalResponses.push(`${resp.status()} ${u}`)
    })
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })
    const kodaUrlBefore = win.url()

    await openFileViaLibrary(win, 'hostile.html')

    const frame = documentFrame(win)
    // Every probe has settled — including the async network ones, whose 4s image timeout is the slowest.
    await expect(frame.locator('body')).toHaveAttribute('data-state', 'settled', { timeout: 30_000 })

    const results = await frame.locator('tr[data-probe]').evaluateAll((rows) =>
      rows.map((row) => ({
        probe: row.getAttribute('data-probe') ?? '',
        outcome: row.getAttribute('data-outcome') ?? '',
        detail: row.lastElementChild?.textContent ?? '',
      })),
    )
    const table = results.map((r) => `${r.probe}: ${r.outcome} — ${r.detail}`).join('\n')
    const outcome = (probe: string): string => results.find((r) => r.probe === probe)?.outcome ?? 'MISSING'

    // The fixture's own recorded contract: nothing completed.
    await expect(frame.locator('body')).toHaveAttribute('data-escaped', '0')
    expect(results.filter((r) => r.outcome === 'ALLOWED'), `escapes:\n${table}`).toHaveLength(0)

    // Named one by one, so a future regression says WHICH boundary moved rather than "a number changed".
    for (const probe of [
      'fetch external', // no network at all: CSP default-src 'none' withdraws connect, so fetch throws
      'external image', // CSP img-src data: blob: — a remote pixel has nowhere to load from
      'xhr file://', // no local file read
      'require', // no Node
      'process',
      'module',
      'global',
      'Buffer',
      'window.koda', // no Koda bridge / IPC
      'window.electron',
      'ipcRenderer',
      'preload globals',
      'read top.location', // opaque origin: cannot even look at Koda's window
      'window.open', // no popup route out
      'localStorage', // opaque origin: no storage, no cookies
      'cookie',
    ]) {
      expect(outcome(probe), `${probe} was not blocked:\n${table}`).toBe('blocked')
    }
    // The four escapes a browser drops without a usable in-frame signal: navigating top/parent and the
    // form's target=_top submit (silently dropped), and sendBeacon (returns `true` optimistically even
    // when CSP blocks the send). None may ever be ALLOWED; their real proof is not the row but the
    // effect check below plus the response CSP asserted in preview.test.ts.
    for (const probe of ['navigate top', 'navigate parent', 'form exfil', 'sendBeacon', 'self-nav app-preview'])
      expect(['blocked', 'attempted'], `${probe}:\n${table}`).toContain(outcome(probe))

    // The effect check the document cannot make for itself: Koda's own window never moved, no second
    // window opened, and the frame is still showing the fixture rather than a takeover page.
    expect(win.url()).toBe(kodaUrlBefore)
    expect(app.windows()).toHaveLength(1)
    await expect(frame.locator('h1')).toContainText('every row below must read')
    await expect(win.getByRole('button', { name: 'New chat' })).toBeVisible()

    // The self-navigation containment (probe 8): the fixture recovered its host, stripped the `doc-`
    // prefix, and tried to navigate the frame ITSELF to that guessed app-preview origin to shed the
    // no-network CSP. It must have been denied — the frame never left its own `doc-` origin.
    await expect(frame.locator('body')).toHaveAttribute('data-selfnav', 'attempted', { timeout: 10_000 })
    // Give any (incorrectly allowed) navigation the time it would need to actually commit before we
    // assert it did not — a passing run has nothing to commit because the guard cancelled it.
    await win.waitForTimeout(1000)
    // Every koda-preview frame navigation — including the initial document load — stayed on a `doc-`
    // host. A commit to a bare token host is the app-preview origin, which is exactly the escape.
    for (const u of previewFrameNavigations)
      expect(new URL(u).hostname, `document frame left its origin: ${u}`).toMatch(/^doc-/)
    // And the frame is, right now, still on its document origin.
    const previewHosts = win
      .frames()
      .map((f) => f.url())
      .filter((u) => u.startsWith('koda-preview://'))
      .map((u) => new URL(u).hostname)
    expect(previewHosts, 'the document frame is gone').not.toHaveLength(0)
    for (const host of previewHosts) expect(host, `frame host: ${host}`).toMatch(/^doc-/)
    // The frame kept its no-network CSP throughout, so no external host was ever answered.
    expect(externalResponses, `unexpected external responses:\n${externalResponses.join('\n')}`).toHaveLength(0)

    // The canary, asked for from inside the frame's own origin. This runs in Playwright's isolated
    // world, which is exempt from the page's CSP — which is exactly why it is worth running: it steps
    // over the policy layer and lands on the SERVER rule, so what it proves is that main refuses every
    // path but the open document, not merely that the CSP stopped the request. Either answer is a
    // refusal; neither may carry the bytes.
    const sibling = await frame.locator('body').evaluate(async () => {
      try {
        const res = await fetch(new URL('/not-for-the-document.txt', location.href).href)
        return `status ${res.status}: ${(await res.text()).slice(0, 40)}`
      } catch (err) {
        return `blocked: ${(err as Error).message}`
      }
    })
    expect(sibling, 'a sibling project file was served to the document origin').toMatch(
      /^(?:blocked:|status 404)/,
    )
    expect(sibling).not.toContain('PRIVATE-CANARY-VALUE')

    expect(existsSync(join(project, 'not-for-the-document.txt'))).toBe(true)
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
  }
})
