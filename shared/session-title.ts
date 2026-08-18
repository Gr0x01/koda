/**
 * Labels that describe a session's temporary state rather than its subject. They may be shown while
 * there is no text to name yet, but they never count as a settled title: the first real prompt is
 * still allowed to replace them and sibling-title collision checks ignore them.
 *
 * Keep this shared. The phone adoption path previously treated "From your phone" as provisional in
 * one place and final in two others, which is how the placeholder became permanent.
 */
export const NEW_SESSION_TITLE = 'New session'
export const PHONE_SESSION_TITLE = 'From your phone'

export function isProvisionalSessionTitle(label: string | null | undefined): boolean {
  const title = label?.trim()
  return !title || title === NEW_SESSION_TITLE || title === PHONE_SESSION_TITLE
}

/** Whether a transcript row contains human text that can name a session. Remote replay represents an
 *  image-only turn with this sentinel, so every hydration/adoption/live path must reject it alike. */
export function isSessionNamingPrompt(text: string | null | undefined): boolean {
  const prompt = text?.trim()
  return !!prompt && prompt !== '(image)'
}

/** The instant title shown before a configured writer answers. Shared because desktop-first and
 *  phone-first sessions must persist the same floor when the writer is unavailable. */
export function titleFromPrompt(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length <= 40 ? clean : `${clean.slice(0, 40).trimEnd()}…`
}
