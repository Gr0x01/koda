/** Inputs each head already owns for assigning a live session to Needs You or Active. Keeping only the
 * precedence here lets desktop retain its status model and the phone retain per-device revision state. */
export type SessionNeedsYouSignals = {
  gate: boolean
  working: boolean
  terminalError: boolean
  unseenAttention: boolean
}

/** A live gate always needs the user. Otherwise current work suppresses terminal attention until it
 * settles; an idle error or unseen completion then needs the user. */
export function sessionNeedsYou({
  gate,
  working,
  terminalError,
  unseenAttention,
}: SessionNeedsYouSignals): boolean {
  if (gate) return true
  if (working) return false
  return terminalError || unseenAttention
}
