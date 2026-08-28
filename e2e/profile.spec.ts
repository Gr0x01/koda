import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchKoda, makeUserDataDir } from './support/koda'

test('E2E owns its app identity, state, logs, and credential home', async () => {
  const userDataDir = makeUserDataDir('koda-profile-e2e-')
  const priorTokenSentinel = process.env.OPENAI_TEST_SENTINEL
  const priorAskpass = process.env.GIT_ASKPASS
  process.env.OPENAI_TEST_SENTINEL = 'must-not-cross-the-e2e-boundary'
  process.env.GIT_ASKPASS = '/must/not/cross'
  try {
    const app = await launchKoda({ userDataDir })
    try {
      const win = await app.firstWindow()
      await expect(win.getByRole('heading', { name: 'Open a project' })).toBeVisible({ timeout: 15_000 })
      const paths = await app.evaluate(({ app }) => ({
        name: app.getName(),
        userData: app.getPath('userData'),
        logs: app.getPath('logs'),
        home: process.env.HOME,
        tokenSentinel: process.env.OPENAI_TEST_SENTINEL,
        askpass: process.env.GIT_ASKPASS,
      }))
      expect(paths.name).toBe('Koda E2E')
      expect(paths.userData).toBe(userDataDir)
      expect(paths.logs).toBe(join(userDataDir, 'logs'))
      expect(paths.home).toBe(join(userDataDir, 'home'))
      expect(paths.tokenSentinel).toBeUndefined()
      expect(paths.askpass).toBeUndefined()

      const accountGuards = await win.evaluate(async () => {
        const subscription = await window.koda.startLogin()
        const codex = await window.koda.startCodexLogin()
        let sessionError = ''
        let credentialError = ''
        try {
          await window.koda.startSession({})
        } catch (error) {
          sessionError = String(error)
        }
        try {
          await window.koda.saveApiKey('not-a-real-key')
        } catch (error) {
          credentialError = String(error)
        }
        return { subscription, codex, sessionError, credentialError }
      })
      expect(accountGuards.subscription).toMatchObject({ ok: false })
      expect(accountGuards.codex).toMatchObject({ ok: false })
      expect(accountGuards.sessionError).toContain('disabled in hermetic Koda E2E')
      expect(accountGuards.credentialError).toContain('disabled in hermetic Koda E2E')

      // StatusBar probes may create the isolated Codex directory, but must not copy the user's auth into it.
      expect(existsSync(join(userDataDir, 'codex', 'auth.json'))).toBe(false)
    } finally {
      await app.close()
    }
  } finally {
    if (priorTokenSentinel === undefined) delete process.env.OPENAI_TEST_SENTINEL
    else process.env.OPENAI_TEST_SENTINEL = priorTokenSentinel
    if (priorAskpass === undefined) delete process.env.GIT_ASKPASS
    else process.env.GIT_ASKPASS = priorAskpass
  }
})

test('two E2E installs coexist because their identity is scoped by userData', async () => {
  const first = await launchKoda()
  const second = await launchKoda()
  try {
    await Promise.all([first.firstWindow(), second.firstWindow()])
    expect(await first.evaluate(({ app }) => app.getName())).toBe('Koda E2E')
    expect(await second.evaluate(({ app }) => app.getName())).toBe('Koda E2E')
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})
