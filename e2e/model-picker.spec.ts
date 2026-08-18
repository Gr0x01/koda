import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir } from './support/koda'

const storeName = (projectPath: string): string =>
  `koda-sessions-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}.json`

test('model and reasoning controls use the provider drill-down and carry the full posture into a new chat', async (
  { browserName: _browserName },
  testInfo,
) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'koda-picker-proj-')))
  const userDataDir = makeUserDataDir('koda-pick-')
  writeFileSync(
    join(userDataDir, storeName(project)),
    JSON.stringify({
      version: 3,
      projectPath: project,
      activeId: 'picker-session',
      sessions: [
        {
          id: 'picker-session',
          label: 'Model picker proof',
          cwd: project,
          approvalMode: 'auto',
          engineId: 'claude',
          model: 'opus',
          effort: 'high',
          items: [{ id: 1, kind: 'user', text: 'Keep this conversation on Claude.' }],
        },
      ],
    }),
  )

  const app = await launchKoda({ projectPath: project, userDataDir })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    const model = win.getByRole('button', { name: 'Model: Opus' })
    await expect(model).toBeVisible({ timeout: 20_000 })

    await model.click()
    await expect(win.getByText('Anthropic · switch provider')).toBeVisible()
    await expect(win.getByText('For your toughest challenges')).toBeVisible()
    await expect(win.getByText('Engine default')).toBeVisible()
    await testInfo.attach('model-picker-current-provider', {
      body: await win.screenshot(),
      contentType: 'image/png',
    })

    await win.getByRole('button', { name: /Claude.*switch provider/ }).click()
    await expect(win.getByRole('heading', { name: 'AI providers' })).toBeVisible()
    await expect(win.getByText('Choose where this chat runs')).toBeVisible()
    const codex = win.getByRole('button', { name: /Codex.*New chat required to switch/ })
    await expect(codex).toBeVisible()
    await codex.click()
    await expect(win.getByText('OpenAI · switch provider')).toBeVisible()
    await expect(win.getByText(/This conversation is already running on Claude/)).toBeVisible()

    // Return to the current provider, then exercise the separate reasoning control.
    await win.getByRole('button', { name: /Codex.*switch provider/ }).click()
    await win.getByRole('button', { name: /Claude.*Anthropic/ }).click()
    await model.click()

    const reasoning = win.getByRole('button', { name: 'Reasoning effort: High' })
    await reasoning.click()
    await expect(win.getByText('Balanced speed and depth')).toBeVisible()
    await expect(win.getByText('The most reasoning the engine offers')).toBeVisible()
    await testInfo.attach('reasoning-picker', {
      body: await win.screenshot(),
      contentType: 'image/png',
    })
    await win.getByRole('button', { name: /Max.*The most reasoning/ }).click()
    await expect(win.getByRole('button', { name: 'Reasoning effort: Max' })).toBeVisible()

    // Main is the durable owner of the next-chat posture. Prove the real seam by opening a fresh chat,
    // not by inspecting a renderer cache: both model and reasoning must arrive in the new session.
    await win.getByRole('button', { name: 'New chat' }).click()
    await expect(win.getByRole('button', { name: 'Model: Opus' })).toBeVisible()
    await expect(win.getByRole('button', { name: 'Reasoning effort: Max' })).toBeVisible()
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toHaveLength(0)
  } finally {
    await app.close()
  }
})
