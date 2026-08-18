/**
 * Anonymous usage events — the single chokepoint, same philosophy as buildEngineEnv(): every event
 * flows through track(), and nothing else in the app may talk to PostHog. Consent is PRESENTED
 * default-on (decided 2026-07-09): the setting defaults to on, but every send is also gated on
 * hasOnboarded, so on a fresh install nothing flows until the user has walked past the visible
 * toggle on the onboarding safety step — default-on without collect-before-they-could-decline.
 * Off means zero pings, read live so the toggle applies instantly.
 *
 * Content-free by construction, not by scrubbing: TelemetryEvents below is the complete wire
 * vocabulary — fixed event names with typed props — so file paths, prompts, code, and project names
 * physically can't ride along. No SDK on purpose: a raw POST keeps the entire wire format readable
 * in this one file, and nothing we didn't write can phone home. Events carry a random install id
 * tied to nothing about the user, and $process_person_profile:false keeps them anonymous on
 * PostHog's side (no person profile is ever created).
 *
 * The site's /privacy Analytics section describes exactly this behavior — change them together.
 */
import { app } from 'electron'
import type { FriendlyEngineError } from '@shared/engine-error'
import { loadHasOnboarded, loadTelemetryEnabled, loadTelemetryInstallId } from './settings'
import { POSTHOG_KEY } from './koda-service-config'
import { log } from './logger'
import { isE2EProfile } from './runtime-profile'

const POSTHOG_HOST = 'https://us.i.posthog.com'

/** The complete event vocabulary. Extend deliberately; never accept a free-form string or object. */
type TelemetryEvents = {
  /** Once per app launch. */
  app_opened: Record<string, never>
  /** The onboarding wizard was finished (hasOnboarded flipped true). The activation funnel's first
   *  step; fired once, right after the flag persists so it clears the send gate. */
  onboarding_completed: Record<string, never>
  /** A new project folder was created (nothing about it — just that one was). */
  project_created: Record<string, never>
  /** The first turn of this app run reached an engine — the "actively used" signal. */
  first_turn_sent: Record<string, never>
  /** A preview surface opened: a static file or a dev server. */
  preview_opened: { kind: 'static' | 'dev' }
  /** A background workflow run launched. */
  workflow_run: Record<string, never>
  /** An engine turn failed — the typed classifier tone only, never the message (messages can carry
   *  file paths). */
  engine_error: { tone: FriendlyEngineError['tone']; fatal: boolean }
}

export function track<E extends keyof TelemetryEvents>(event: E, props: TelemetryEvents[E]): void {
  // Tests are product instrumentation, not product usage. This hard gate also protects a future test
  // that forgets to seed telemetryEnabled:false in its throwaway settings.
  if (isE2EProfile()) return
  // The hasOnboarded gate is what makes default-on honest: the consent toggle is on the onboarding
  // safety step, so nothing may leave before the user has been shown it.
  if (!loadHasOnboarded() || !loadTelemetryEnabled()) return
  void send(event, props)
}

/** first_turn_sent guard — once per app run, so turn volume never becomes a usage trace. */
let firstTurnSent = false
export function trackFirstTurn(): void {
  if (firstTurnSent) return
  firstTurnSent = true
  track('first_turn_sent', {})
}

/** Fire-and-forget; a telemetry failure must never surface to the user or block anything. */
async function send(event: string, props: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: loadTelemetryInstallId(),
        timestamp: new Date().toISOString(),
        properties: {
          ...props,
          app_version: app.getVersion(),
          $process_person_profile: false,
        },
      }),
    })
    if (!res.ok) log.warn('telemetry', `capture rejected: ${res.status}`)
  } catch (err) {
    log.warn('telemetry', 'capture failed', err instanceof Error ? err.message : err)
  }
}
