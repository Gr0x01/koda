/** One classifier for assistant links on every Koda control head. Trust still belongs to main: a
 * `file` answer means only that the href is shaped like a local identity and must be resolved there. */
export type StageHrefKind =
  | { kind: 'external' }
  | { kind: 'anchor' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'file' }
  | { kind: 'unsupported' }

export const SESSION_HREF_PREFIX = 'koda://session/'

export function sessionHref(sessionId: string): string {
  return `${SESSION_HREF_PREFIX}${encodeURIComponent(sessionId)}`
}

export function parseSessionHref(href: string): string | null {
  if (!href.toLowerCase().startsWith(SESSION_HREF_PREFIX)) return null
  const rest = href.slice(SESSION_HREF_PREFIX.length).split('#')[0].split('?')[0]
  if (!rest || rest.includes('/')) return null
  let id: string
  try {
    id = decodeURIComponent(rest)
  } catch {
    id = rest
  }
  return id.trim() || null
}

export function classifyStageHref(href: string): StageHrefKind {
  const value = href.trim()
  if (!value) return { kind: 'unsupported' }
  if (value.startsWith('#')) return { kind: 'anchor' }
  const sessionId = parseSessionHref(value)
  if (sessionId) return { kind: 'session', sessionId }
  if (/^(?:https?:|mailto:)/i.test(value)) return { kind: 'external' }
  if (/^(?:javascript|vbscript|data):/i.test(value)) return { kind: 'unsupported' }
  if (/^file:/i.test(value)) return { kind: 'file' }
  // `src/a.ts:12` resembles a scheme but is a source location. Other custom schemes are not files.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/:\d+(?::\d+)?(?:#L\d+(?:C\d+)?)?$/i.test(value))
    return { kind: 'unsupported' }
  return { kind: 'file' }
}
