import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir } from './support/koda'

function makeProject(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'koda-set-proj-')))
}

test('text generation picker shares the provider hierarchy and persists model and effort', async (
  { browserName: _browserName },
  testInfo,
) => {
  // Keep this short: Electron's singleton socket sits below userData, and the lab job root is
  // already deep enough that a descriptive prefix can exceed the platform's Unix-socket limit.
  const userDataDir = makeUserDataDir('koda-set-')
  const app = await launchKoda({
    projectPath: makeProject(),
    userDataDir,
    settings: { textGenerationModel: { provider: 'apple' } },
  })
  const pageErrors: string[] = []
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.getByRole('button', { name: 'New chat' }).waitFor({ timeout: 20_000 })

    await win.getByRole('button', { name: 'Settings' }).click()
    const modelPicker = win.getByRole('button', { name: 'Text generation model' })
    const effortPicker = win.getByRole('button', { name: 'Generated text effort' })
    const writerMenu = win.getByRole('listbox', { name: 'Text generation writers' })
    const claudeMenu = win.getByRole('listbox', { name: 'Claude text generation models' })
    const effortMenu = win.getByRole('listbox', { name: 'Generated text effort' })

    await expect(modelPicker).toContainText('Apple Intelligence')
    await expect(effortPicker).toHaveCount(0)

    await modelPicker.click()
    await expect(writerMenu).toBeVisible()
    await expect(win.getByRole('option', { name: /^Codex/ })).toBeVisible()
    await win.getByRole('option', { name: /^Claude/ }).click()
    await expect(writerMenu).toBeHidden()
    await expect(claudeMenu).toBeVisible()
    await expect(win.getByRole('option', { name: /^Fable Recommended/ })).toBeVisible()
    await testInfo.attach('text-generation-model-menu', {
      body: await win.screenshot(),
      contentType: 'image/png',
    })

    await win.getByRole('option', { name: /^Opus/ }).click()
    await expect(modelPicker).toContainText('Claude Opus')
    await expect(claudeMenu).toBeHidden()
    await expect(effortPicker).toContainText('Off')

    await effortPicker.click()
    await win.getByRole('option', { name: /^High/ }).click()
    await expect(effortPicker).toContainText('High')
    await expect(effortMenu).toBeHidden()

    await expect
      .poll(() => JSON.parse(readFileSync(join(userDataDir, 'koda-settings.json'), 'utf8')).textGenerationModel)
      .toEqual({ provider: 'claude', model: 'opus', effort: 'high' })

    await win.keyboard.press('Escape')
    await expect(win.getByRole('heading', { name: 'General' })).toHaveCount(0)
    await win.getByRole('button', { name: 'Settings' }).click()
    await expect(modelPicker).toContainText('Claude Opus')
    await expect(effortPicker).toContainText('High')

    // Both portaled menus move focus to the selected option and restore it to their trigger.
    await modelPicker.focus()
    await modelPicker.press('ArrowDown')
    await expect(claudeMenu).toBeVisible()
    await expect(win.getByRole('option', { name: /^Opus/ })).toBeFocused()
    await win.keyboard.press('Home')
    await expect(win.getByRole('option', { name: /^Fable/ })).toBeFocused()
    await win.keyboard.press('End')
    await expect(win.getByRole('option', { name: /^Haiku/ })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(claudeMenu).toBeHidden()
    await expect(modelPicker).toBeFocused()

    await effortPicker.focus()
    await effortPicker.press('ArrowDown')
    await expect(effortMenu).toBeVisible()
    await expect(win.getByRole('option', { name: /^High/ })).toBeFocused()
    await win.keyboard.press('Home')
    await expect(win.getByRole('option', { name: /^Off/ })).toBeFocused()
    await win.keyboard.press('End')
    await expect(win.getByRole('option', { name: /^Max/ })).toBeFocused()
    await win.keyboard.press('Escape')
    await expect(effortMenu).toBeHidden()
    await expect(effortPicker).toBeFocused()

    await effortPicker.press('ArrowDown')
    await expect(win.getByRole('option', { name: /^High/ })).toBeFocused()
    await win.keyboard.press('ArrowDown')
    await expect(win.getByRole('option', { name: /^X-high/ })).toBeFocused()
    await win.keyboard.press('Enter')
    await expect(effortPicker).toContainText('X-high')
    await expect(effortPicker).toBeFocused()

    // The provider header drills back to local writers; those remove the Claude-only effort control.
    await modelPicker.click()
    await win.getByRole('button', { name: /Claude.*switch writer/ }).click()
    await expect(writerMenu).toBeVisible()
    await win.getByRole('option', { name: /^Plain local text/ }).click()
    await expect(modelPicker).toContainText('Plain local text')
    await expect(effortPicker).toHaveCount(0)

    // The same broadcast another window receives reconciles the compound control in place.
    await win.evaluate(() =>
      window.koda.updateSettings({
        textGenerationModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      }),
    )
    await expect(modelPicker).toContainText('Codex GPT 5.6')
    await expect(effortPicker).toContainText('High')

    expect(pageErrors, 'page errors:\n' + pageErrors.join('\n')).toHaveLength(0)
  } finally {
    await app.close()
  }
})
