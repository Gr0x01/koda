import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir } from './support/koda'

const storeName = (projectPath: string): string =>
  `koda-sessions-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`

/**
 * A model the engine refused has to read as a refusal, not as an answer. The failure is seeded as the
 * durable envelope a real rejection leaves behind (`error.errorCode` + `error.model`, exactly what the
 * driver now lifts out of the CLI's synthetic assistant event), so this also proves the restore path:
 * reopening the session has to rebuild copy that still names the refused ID rather than falling back to
 * generic failure wording.
 */
test('a refused model names itself instead of reading as an answer', async (
  { browserName: _browserName },
  testInfo,
) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-refused-proj-')))
  const userDataDir = makeUserDataDir('koda-refused-')
  const refusal =
    "There's an issue with the selected model (claude-opus-5.5). It may not exist or you may not have access to it. Run --model to pick a different model."
  writeFileSync(
    join(userDataDir, storeName(project)),
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'refused-session',
      sessions: [
        {
          id: 'refused-session',
          label: 'Refused model proof',
          cwd: project,
          approvalMode: 'auto',
          engineId: 'claude',
          model: 'claude-opus-5.5',
          effort: 'high',
          items: [
            {
              id: 1,
              kind: 'user',
              text: 'Off the menu and onto the ground?',
              turnFailure: {
                error: {
                  type: 'EngineError',
                  sessionId: 'refused-session',
                  message: refusal,
                  fatal: false,
                  category: 'apiError',
                  errorCode: 'model_not_found',
                  model: 'claude-opus-5.5',
                },
                target: { userId: 1, text: 'Off the menu and onto the ground?', hadImages: false },
              },
            },
          ],
        },
      ],
    }),
  )

  const app = await launchKoda({ projectPath: project, userDataDir })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))

    await expect(win.getByText('That model is not available.')).toBeVisible({ timeout: 20_000 })
    await expect(win.getByText('No model called claude-opus-5.5.', { exact: false })).toBeVisible()
    // The engine's own sentence stays out of the conversation: rendering it there is what made a failed
    // turn look like the agent answering while the session kept its old model.
    await expect(win.getByText('Run --model to pick a different model.')).toHaveCount(0)
    // A retry would send the same refused id, so the banner must not offer one.
    await expect(win.getByRole('button', { name: 'Try again' })).toHaveCount(0)

    await testInfo.attach('refused-model-banner', {
      body: await win.screenshot(),
      contentType: 'image/png',
    })

    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})
