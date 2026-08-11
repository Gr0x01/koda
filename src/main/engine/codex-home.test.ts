import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/koda-test' } }))
vi.mock('../settings', () => ({ loadMiniAppsEnabled: () => false }))
vi.mock('../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

const { codexPluginJson } = await import('./codex-home')
const {
  codexCleanFinishHooksJson,
  isKodaCleanFinishHook,
  KODA_CLEAN_FINISH_COMMAND,
  KODA_CLEAN_FINISH_HOOK_KEY,
  kodaCleanFinishCommandForSource,
} = await import('./codex-clean-finish')

describe('Codex plugin manifest', () => {
  it('advertises the bundled clean-finish hook only when its files were materialized', () => {
    expect(JSON.parse(codexPluginJson('0.1.9', true))).toMatchObject({
      name: 'koda',
      hooks: './hooks/hooks.json',
    })
    expect(JSON.parse(codexPluginJson('0.1.9', false))).not.toHaveProperty('hooks')
  })

  it('generates and recognizes only Koda\'s exact isolated Stop hook', () => {
    const declaration = JSON.parse(codexCleanFinishHooksJson()) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> }
    }
    expect(declaration.hooks.Stop[0].hooks[0].command).toBe(KODA_CLEAN_FINISH_COMMAND)

    const sourcePath = '/tmp/koda-home/plugins/cache/koda-market/koda/0.1.9/hooks/hooks.json'
    const exact = {
      key: KODA_CLEAN_FINISH_HOOK_KEY,
      eventName: 'stop',
      handlerType: 'command',
      executionMode: 'sync',
      pluginId: 'koda@koda-market',
      command: kodaCleanFinishCommandForSource(sourcePath),
      timeoutSec: 10,
      statusMessage: 'Checking that this topic is saved',
      sourcePath,
    }
    expect(isKodaCleanFinishHook(exact, '/tmp/koda-home')).toBe(true)
    expect(isKodaCleanFinishHook({ ...exact, command: '/tmp/replaced-hook' }, '/tmp/koda-home')).toBe(false)
    expect(
      isKodaCleanFinishHook(
        { ...exact, sourcePath: '/tmp/other/hooks/hooks.json' },
        '/tmp/koda-home',
      ),
    ).toBe(false)
  })
})
