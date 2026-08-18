/**
 * Turn a raw engine/API failure into calm, branded copy for the composer error banner (desktop +
 * mobile share this so the wording matches). The bundled CLI surfaces API failures as verbose
 * assistant text ("API Error: 500 Internal server error. This is a server-side issue…"); this maps
 * the shape to a short headline + one plain sentence, and says whether a plain "Try again" can fix it.
 *
 * Copy rules: no em-dashes, no "X, not Y", calm and plain. The audience is curious and capable, so no
 * comfort filler — just what happened and what to do.
 */
export type EngineErrorTone = 'provider' | 'rate' | 'auth' | 'billing' | 'network' | 'engine' | 'generic'

export interface FriendlyEngineError {
  tone: EngineErrorTone
  title: string
  detail: string
  /** A plain re-send can plausibly clear it (transient). Auth/billing need the user to act first. */
  retryable: boolean
  /** A fix the user can take right now, surfaced as a one-click button on the banner (desktop) so they
   *  don't have to know where Settings lives. 'signin' → open the AI-providers sign-in; 'settings' →
   *  open the same section for a billing fix. Absent for transient/retryable failures. */
  action?: 'signin' | 'settings'
}

/** Sentinel `EngineErrorBanner.message` for a phone turn that never reached the Mac (relay drop / no
 *  ack). Not an engine/Anthropic failure, but shown through the same composer banner — matched first
 *  below so it gets its own calm copy instead of falling through to the generic engine wording. */
export const RELAY_UNREACHABLE = 'koda:relay-unreachable'

/** Sentinel for the one phone failure a retry CANNOT fix: a photo turn that never reached the Mac, whose
 *  image bytes lived only in memory and died with an app reload (see outbox.ts). Saying "it's still here,
 *  try again" there would be a lie, and retrying would send the caption without the photos. Not retryable,
 *  so the banner shows the fix instead of a Try again button. */
export const RELAY_IMAGES_LOST = 'koda:relay-images-lost'

/** Generic successor to RELAY_IMAGES_LOST. Covers photos as well as document attachments whose exact
 * bytes were deliberately not retained across a reload. Keep the old sentinel readable for history. */
export const RELAY_ATTACHMENTS_LOST = 'koda:relay-attachments-lost'

/** Provider-side failure shapes. The single definition: the status pill (status-watch, via the drivers'
 *  EngineError) and the banner copy below both classify from THIS, so a user can never be told the
 *  provider is down by one surface and something else by the other. */
export function looksLikeProviderDown(message: string): boolean {
  return /\b(500|502|503|504|529)\b|overloaded|internal server error|service unavailable|temporarily unavailable|upstream unavailable|bad gateway|gateway timeout/i.test(
    message,
  )
}

export function friendlyEngineError(message: string, fatal: boolean): FriendlyEngineError {
  const m = message.toLowerCase()

  if (message === RELAY_UNREACHABLE)
    return {
      tone: 'network',
      title: "Message didn't reach your Mac",
      detail: "It's still here. Try again.",
      retryable: true,
    }

  if (message === RELAY_IMAGES_LOST)
    return {
      tone: 'network',
      title: "Your photos didn't reach your Mac",
      detail: "They didn't survive the app restart. Attach them again.",
      retryable: false,
    }

  if (message === RELAY_ATTACHMENTS_LOST)
    return {
      tone: 'network',
      title: "Your attachments didn't reach your Mac",
      detail: "They didn't survive the app restart. Attach them again.",
      retryable: false,
    }

  if (/\b(401|403)\b|unauthorized|authentication_error|invalid api key|invalid x-api-key|oauth|expired token|not logged in|please run.*login/.test(m))
    return {
      tone: 'auth',
      title: 'Your account is signed out',
      detail: 'Sign in to keep going, then send your message again.',
      retryable: false,
      action: 'signin',
    }

  if (/credit balance|insufficient|billing|payment|out of credit/.test(m))
    return {
      tone: 'billing',
      title: 'Your plan is out of credit',
      detail: 'Add credit or switch accounts to keep going.',
      retryable: false,
      action: 'settings',
    }

  if (/\b429\b|rate.?limit|too many requests|quota exceeded/.test(m))
    return {
      tone: 'rate',
      title: 'Claude is a little busy right now',
      detail: 'This usually clears in a few seconds. Try again in a moment.',
      retryable: true,
    }

  if (looksLikeProviderDown(m))
    return {
      tone: 'provider',
      title: 'Claude had a brief server hiccup',
      detail: "This is on Claude's side and usually clears fast. Try again in a moment.",
      retryable: true,
    }

  if (/network|timed out|timeout|econn|enotfound|socket hang up|fetch failed|dns|offline/.test(m))
    return {
      tone: 'network',
      title: 'The connection dropped',
      detail: 'Check your internet, then try again.',
      retryable: true,
    }

  if (fatal)
    return {
      tone: 'engine',
      title: 'The session stopped unexpectedly',
      detail: 'Koda can pick up right where you left off. Try again.',
      retryable: true,
    }

  return {
    tone: 'generic',
    title: 'Something went wrong',
    detail: firstSentence(message) || 'Try again in a moment.',
    retryable: true,
  }
}

/** The first sentence of a raw error, minus the CLI's "API Error:" prefix — a readable fallback line. */
function firstSentence(message: string): string {
  const cleaned = message.replace(/^api error:\s*/i, '').trim()
  const stop = cleaned.search(/[.!?](\s|$)/)
  return (stop === -1 ? cleaned : cleaned.slice(0, stop + 1)).trim()
}
