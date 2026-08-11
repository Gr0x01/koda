import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const KODA_PLUGIN_ID = 'koda@koda-market'
export const KODA_CLEAN_FINISH_COMMAND =
  '/usr/bin/osascript -l JavaScript "${PLUGIN_ROOT}/hooks/clean-finish.js"'
export const KODA_CLEAN_FINISH_STATUS = 'Checking that this topic is saved'
export const KODA_CLEAN_FINISH_TIMEOUT_SEC = 10
export const KODA_CLEAN_FINISH_HOOK_KEY = `${KODA_PLUGIN_ID}:hooks/hooks.json:stop:0:0`

export interface CodexHookSummary {
  key?: string
  eventName?: string
  handlerType?: string
  executionMode?: string
  pluginId?: string | null
  command?: string | null
  timeoutSec?: number | null
  statusMessage?: string | null
  sourcePath?: string | null
  currentHash?: string | null
  trustStatus?: string
}

/** One source of truth for the hook declaration copied into Koda's generated Codex plugin. */
export function codexCleanFinishHooksJson(): string {
  return JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: KODA_CLEAN_FINISH_COMMAND,
                timeout: KODA_CLEAN_FINISH_TIMEOUT_SEC,
                statusMessage: KODA_CLEAN_FINISH_STATUS,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )
}

export function kodaCleanFinishCommandForSource(sourcePath: string): string {
  const pluginRoot = dirname(dirname(sourcePath))
  return `/usr/bin/osascript -l JavaScript "${join(pluginRoot, 'hooks', 'clean-finish.js')}"`
}

/**
 * Auto-trust is reserved for the exact hook Koda generated inside Koda's isolated Codex home. A
 * project hook, another plugin hook, or even a near-match added to Koda's plugin stays behind Codex's
 * normal review boundary.
 */
export function isKodaCleanFinishHook(hook: CodexHookSummary, codexHomePath: string): boolean {
  if (!hook.sourcePath || !codexHomePath) return false
  let canonicalHome: string
  try {
    canonicalHome = realpathSync(codexHomePath)
  } catch {
    canonicalHome = resolve(codexHomePath)
  }
  const expectedSource = [...new Set([resolve(codexHomePath), canonicalHome])].some((home) => {
    const fromHome = relative(home, hook.sourcePath as string)
    if (fromHome === '' || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return false
    const parts = fromHome.split(sep)
    return (
      parts.length === 7 &&
      parts[0] === 'plugins' &&
      parts[1] === 'cache' &&
      parts[2] === 'koda-market' &&
      parts[3] === 'koda' &&
      parts[4].length > 0 &&
      parts[5] === 'hooks' &&
      parts[6] === 'hooks.json'
    )
  })

  return (
    expectedSource &&
    hook.key === KODA_CLEAN_FINISH_HOOK_KEY &&
    hook.eventName === 'stop' &&
    hook.handlerType === 'command' &&
    (hook.executionMode === undefined || hook.executionMode === 'sync') &&
    hook.pluginId === KODA_PLUGIN_ID &&
    hook.command === kodaCleanFinishCommandForSource(hook.sourcePath) &&
    hook.timeoutSec === KODA_CLEAN_FINISH_TIMEOUT_SEC &&
    hook.statusMessage === KODA_CLEAN_FINISH_STATUS
  )
}
