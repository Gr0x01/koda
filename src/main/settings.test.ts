import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadCritiquePass,
  loadRemEnabled,
  loadSessionAgentRole,
  loadSettings,
  settingsHealth,
  updateSettings,
} from './settings'
import { log } from './logger'

// The electron stub points getPath('userData') at tmpdir() (see test/electron-stub.ts).
const settingsFile = join(tmpdir(), 'koda-settings.json')
const backupFile = `${settingsFile}.corrupt.bak`

function cleanSettings(): void {
  rmSync(settingsFile, { force: true })
  rmSync(backupFile, { force: true })
  delete process.env.KODA_REM
  delete process.env.KODA_SESSION_AGENT_ROLE
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanSettings()
})

describe('REM dogfood gate', () => {
  it('stays separate from the user-facing memory tidy toggle', () => {
    writeFileSync(settingsFile, JSON.stringify({ dreamEnabled: true }))
    expect(loadRemEnabled()).toBe(false)

    writeFileSync(settingsFile, JSON.stringify({ remEnabled: true }))
    expect(loadRemEnabled()).toBe(true)

    writeFileSync(settingsFile, '{}')
    process.env.KODA_REM = '1'
    expect(loadRemEnabled()).toBe(true)
  })
})

describe('session agent role', () => {
  it('preserves the shipped adaptive behavior when the option is absent or invalid', () => {
    expect(loadSessionAgentRole()).toBe('adaptive')
    writeFileSync(settingsFile, JSON.stringify({ sessionAgentRole: 'always-spawn' }))
    expect(loadSessionAgentRole()).toBe('adaptive')
  })

  it('enables the orchestrator role from this install settings file', () => {
    writeFileSync(settingsFile, JSON.stringify({ sessionAgentRole: 'orchestrator' }))
    expect(loadSessionAgentRole()).toBe('orchestrator')
  })

  it('lets an explicit launch override the persisted role', () => {
    writeFileSync(settingsFile, JSON.stringify({ sessionAgentRole: 'orchestrator' }))
    process.env.KODA_SESSION_AGENT_ROLE = 'adaptive'
    expect(loadSessionAgentRole()).toBe('adaptive')

    process.env.KODA_SESSION_AGENT_ROLE = 'orchestrator'
    expect(loadSessionAgentRole()).toBe('orchestrator')
  })

  it('survives unrelated user-facing settings writes', () => {
    writeFileSync(settingsFile, JSON.stringify({ sessionAgentRole: 'orchestrator' }))
    updateSettings({ notificationsEnabled: false })
    expect(loadSessionAgentRole()).toBe('orchestrator')
  })
})

describe('finishing review preference', () => {
  it('defaults off and preserves an explicit choice', () => {
    expect(loadCritiquePass()).toBe(false)
    expect(loadSettings().critiquePass).toBe(false)
    writeFileSync(settingsFile, JSON.stringify({ critiquePass: true }))
    expect(loadCritiquePass()).toBe(true)
    expect(loadSettings().critiquePass).toBe(true)
  })
})

// Item 16: readSettings() used to return {} on ANY throw with no log, conflating first-run (benign)
// with real corruption/EACCES, and every writer spread from that {} and wrote it straight back.
describe('a missing settings file is first-run, not corruption', () => {
  it('reads as defaults with no warning logged', () => {
    cleanSettings()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const settings = loadSettings()
    expect(settings.billingMode).toBe('subscription')
    expect(settings.hasOnboarded).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a zero-length file also reads as absent, not corrupt (same torn-write case as session-store)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '')
    loadSettings()
    expect(warn).not.toHaveBeenCalled()
    expect(existsSync(backupFile)).toBe(false)
  })
})

describe('text generation model', () => {
  it('defaults to Apple Intelligence on-device', () => {
    cleanSettings()
    expect(loadSettings().textGenerationModel).toEqual({ provider: 'apple' })
  })

  it('preserves an old combined-assist opt-out as plain text', () => {
    writeFileSync(settingsFile, JSON.stringify({ assistEnabled: false }))
    expect(loadSettings().textGenerationModel).toEqual({ provider: 'plain' })
  })

  it('migrates a pre-effort Claude choice to the original thinking-off behavior', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ textGenerationModel: { provider: 'claude', model: 'sonnet' } }),
    )
    expect(loadSettings().textGenerationModel).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'off',
    })
  })

  it('persists an explicit safe Claude alias and effort', () => {
    updateSettings({
      textGenerationModel: { provider: 'claude', model: 'sonnet', effort: 'high' },
    })
    expect(loadSettings().textGenerationModel).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
    })
  })

  it('persists a Codex catalog model and reasoning effort', () => {
    updateSettings({
      textGenerationModel: { provider: 'codex', model: 'gpt-current', effort: 'high' },
    })
    expect(loadSettings().textGenerationModel).toEqual({
      provider: 'codex',
      model: 'gpt-current',
      effort: 'high',
    })
  })

  it('does not let the now-label-only assist toggle change the generated-text choice', () => {
    writeFileSync(settingsFile, JSON.stringify({ assistEnabled: true }))
    updateSettings({ assistEnabled: false })
    expect(loadSettings()).toMatchObject({
      assistEnabled: false,
      textGenerationModel: { provider: 'apple' },
    })
  })
})

describe('a present-but-unreadable settings file logs and keeps a copy before the next write', () => {
  it('warns and backs up the file instead of silently defaulting', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const original = '{"billingMode":"subscription", not json'
    writeFileSync(settingsFile, original)

    const settings = loadSettings()

    expect(settings.billingMode).toBe('subscription') // falls back -- no schema recovery attempted here
    expect(warn.mock.calls.some(([, msg]) => String(msg).includes('present but invalid'))).toBe(true)
    expect(existsSync(backupFile)).toBe(true)
    expect(readFileSync(backupFile, 'utf8')).toBe(original)
  })

  it('does not overwrite an existing backup with a later, different corruption', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, 'first corruption')
    loadSettings()
    expect(readFileSync(backupFile, 'utf8')).toBe('first corruption')

    writeFileSync(settingsFile, 'second, different corruption')
    loadSettings()
    expect(readFileSync(backupFile, 'utf8')).toBe('first corruption') // unchanged
  })

  it('a real read error (not ENOENT) is logged too', () => {
    // JSON.parse throwing and readFileSync throwing both count as "present but unreadable" here; the
    // distinction that matters is ENOENT vs everything else, which the JSON-parse-failure case above
    // already exercises for the common real-world trigger (schema/version drift, not disk corruption).
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '{not valid json at all')
    loadSettings()
    expect(warn).toHaveBeenCalled()
  })
})

// The one part of this that is not narrow: billingMode flipping from 'api' to 'subscription' silently
// violates CLAUDE.md's "switching billing is user-visible, never silent." The flip is safe-direction
// (api can never materialize out of nothing), so this pins that it's at least LOGGED, not invisible.
describe('a lost billingMode does not silently become a different billing mode', () => {
  it('warns specifically when the corrupt file appears to have had billingMode "api"', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '{"billingMode":"api", "approvalMode": broken')

    const settings = loadSettings()

    expect(settings.billingMode).toBe('subscription') // the flip DOES happen (the safe direction)...
    // ...but it must not be silent:
    expect(
      warn.mock.calls.some(
        ([, msg]) => String(msg).toLowerCase().includes('billingmode') && String(msg).includes('api'),
      ),
    ).toBe(true)
  })

  it('the .corrupt.bak still holds the original "api" value even after the next write', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '{"billingMode":"api", broken')

    updateSettings({ notificationsEnabled: false }) // a write that spreads readSettings()

    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).billingMode).toBeUndefined() // live file lost it
    expect(readFileSync(backupFile, 'utf8')).toContain('"billingMode":"api"') // but it's recoverable
  })

  it('does not warn about billingMode when the corrupt bytes never mention "api"', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '{"billingMode":"subscription", broken')
    loadSettings()
    expect(warn.mock.calls.some(([, msg]) => String(msg).toLowerCase().includes('billingmode'))).toBe(false)
  })

  // W3: a log line is not "user-visible" (CLAUDE.md). The flip has to reach a surface, and this is the
  // fact the data-integrity banner reads over app:dataIntegrity.
  it('reports the lost billing choice for the banner, until the user picks a mode themselves', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    updateSettings({ billingMode: 'subscription' }) // the latch is per-process, so start from a known state
    expect(settingsHealth().billingModeReset).toBe(false)

    writeFileSync(settingsFile, '{"billingMode":"api", broken')
    loadSettings()
    expect(settingsHealth().billingModeReset).toBe(true)

    updateSettings({ billingMode: 'api' }) // they've now said which one they want
    expect(settingsHealth().billingModeReset).toBe(false)
  })
})

// W2: this warning is the one worth finding in the NDJSON log, and it was burying itself. readSettings
// has no cache and 36 call sites in settings.ts, so one loadSettings() on a corrupt file emitted 38
// warnings, 19 of them the billing one — and loadSettings runs on every settings:get and every
// updateSettings return, so opening Settings a few times drowned the log RB reads when debugging.
describe('the corrupt-settings warning does not flood the log it exists to be found in', () => {
  it('says it once per distinct corruption, however many loaders read the file', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    // Content the tests above never wrote: the guard is keyed by the bytes, and it is per-process.
    writeFileSync(settingsFile, '{"billingMode":"api", "flood check", broken')

    loadSettings()
    loadSettings()
    loadSettings()

    const corruptWarnings = warn.mock.calls.filter(([, msg]) => String(msg).includes('present but invalid'))
    const billingWarnings = warn.mock.calls.filter(([, msg]) => String(msg).toLowerCase().includes('billingmode'))
    expect(corruptWarnings).toHaveLength(1)
    expect(billingWarnings).toHaveLength(1)
  })

  it('still speaks up when the file goes corrupt a second, different way', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    writeFileSync(settingsFile, '{"first corruption", broken')
    loadSettings()
    writeFileSync(settingsFile, '{"a different corruption", broken')
    loadSettings()

    expect(warn.mock.calls.filter(([, msg]) => String(msg).includes('present but invalid'))).toHaveLength(2)
  })
})
