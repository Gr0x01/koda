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
}

/** Sentinel `EngineErrorBanner.message` for a phone turn that never reached the Mac (relay drop / no
 *  ack). Not an engine/Anthropic failure, but shown through the same composer banner — matched first
 *  below so it gets its own calm copy instead of falling through to the generic engine wording. */
export const RELAY_UNREACHABLE = 'koda:relay-unreachable'

export function friendlyEngineError(message: string, fatal: boolean): FriendlyEngineError {
  const m = message.toLowerCase()

  if (message === RELAY_UNREACHABLE)
    return {
      tone: 'network',
      title: "Message didn't reach your Mac",
      detail: "It's still here. Try again.",
      retryable: true,
    }

  if (/\b(401|403)\b|unauthorized|authentication_error|invalid api key|invalid x-api-key|oauth|expired token|please run.*login/.test(m))
    return {
      tone: 'auth',
      title: 'Your Claude sign-in needs a refresh',
      detail: 'Reconnect your account in Settings, then try again.',
      retryable: false,
    }

  if (/credit balance|insufficient|billing|payment|out of credit/.test(m))
    return {
      tone: 'billing',
      title: 'Claude is out of credit',
      detail: 'Add credit or switch accounts in Settings to keep going.',
      retryable: false,
    }

  if (/\b429\b|rate.?limit|too many requests|quota exceeded/.test(m))
    return {
      tone: 'rate',
      title: 'Claude is a little busy right now',
      detail: 'This usually clears in a few seconds. Try again in a moment.',
      retryable: true,
    }

  if (/\b(500|502|503|504|529)\b|overloaded|internal server error|service unavailable|bad gateway|gateway timeout|temporarily unavailable/.test(m))
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
