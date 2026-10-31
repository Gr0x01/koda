import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir } from './support/koda'

// A real 1×1 PNG; the thumb only needs to decode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const sessionStoreName = (projectPath: string): string =>
  `koda-sessions-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`

/**
 * The Recent images card's `+` is a hover-revealed badge on each thumb. The pointer path RB actually
 * takes — hover the thumb, slide to the badge, click — must keep the badge shown and the card open all
 * the way to the staged attachment. Driven with real mouse moves, not `hover()` teleports, because the
 * failure mode is the badge or the card vanishing mid-travel.
 */
test('the + badge on a recent image survives the pointer reaching it and stages the attachment', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-ri-proj-')))
  writeFileSync(join(project, 'app.ts'), 'export const answer = 42\n')
  const scratchDir = join(project, '.koda', 'scratch')
  mkdirSync(scratchDir, { recursive: true })
  for (const name of ['one.png', 'two.png', 'three.png', 'four.png', 'five.png', 'six.png']) {
    writeFileSync(join(scratchDir, name), PNG)
  }
  // Short prefix on purpose: Chromium's Linux singleton socket path has a tight length limit.
  const userDataDir = makeUserDataDir('koda-ri-')
  writeFileSync(
    join(userDataDir, sessionStoreName(project)),
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'recent-images-session',
      sessions: [
        {
          id: 'recent-images-session',
          label: 'Recent images session',
          cwd: project,
          items: [{ id: 1, kind: 'user', text: 'Look at these.' }],
        },
      ],
      starredDocs: [],
      legacyKeptDocsImported: [],
    }),
  )

  const app = await launchKoda({ projectPath: project, userDataDir })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    const trigger = win.getByRole('button', { name: 'Recent images (6)' })
    await expect(trigger).toBeVisible({ timeout: 20_000 })
    const triggerBox = (await trigger.boundingBox())!
    await win.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2, { steps: 4 })

    const card = win.locator('[aria-label="Recent images"]')
    await expect(card).toBeVisible()
    const cardBox = (await card.boundingBox())!
    // Cross the gap from the row into the card the way a pointer does, along the row's own line.
    await win.mouse.move(cardBox.x + 20, triggerBox.y + triggerBox.height / 2, { steps: 8 })
    await expect(card).toBeVisible()

    // The right column is the tight case: its badge is the one nearest the grid's scrollbar lane.
    const thumb = win.getByRole('button', { name: 'View three.png' })
    const plus = win.getByRole('button', { name: 'Add three.png to your message' })
    const thumbBox = (await thumb.boundingBox())!
    await win.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2, { steps: 10 })
    await expect(plus).toHaveCSS('opacity', '1')

    const plusBox = (await plus.boundingBox())!
    // The badge sits inside the thumb, so the pointer never has to leave the thumb to reach it.
    expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(thumbBox.x + thumbBox.width)
    expect(plusBox.y).toBeGreaterThanOrEqual(thumbBox.y)
    expect(plusBox.width).toBeGreaterThanOrEqual(20)
    await win.mouse.move(plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2, { steps: 12 })
    // Past the card's 140ms close grace and the badge's opacity transition.
    await win.waitForTimeout(600)
    await expect(card).toBeVisible()
    await expect(plus).toHaveCSS('opacity', '1')
    const topmost = await win.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y)
        return el ? `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.className}]` : 'none'
      },
      [plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2] as const,
    )
    expect(topmost, 'something else is on top of the + badge').toBe('button[Add three.png to your message]')

    await win.mouse.down()
    await win.mouse.up()
    await expect(win.locator('img[alt="attachment"]')).toHaveCount(1)
  } finally {
    await app.close()
  }
  expect(pageErrors).toEqual([])
})
