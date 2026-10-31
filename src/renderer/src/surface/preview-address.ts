/**
 * Turn what was typed into the preview's address bar into a URL the frame may load, or say why it
 * can't. The frame is limited to the project's own origin and a local dev server, so anything else is
 * refused up front with a sentence instead of dying silently against the packaged CSP.
 *
 * Relative input follows Koda's habit rather than a browser's on a project page: a bare `mocks/a.html`
 * is a path from the project root, because that is how every path in the conversation is written;
 * `./` and `../` are relative to the page on screen, as in a browser; `/x` is the root either way. On a
 * dev-server page the browser rules apply unchanged, since the server owns its own paths.
 */
export type PreviewAddress = { url: string } | { refused: string }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const REFUSED = 'Only local pages can be previewed here: a file in this project, or a localhost server.'

export function resolvePreviewAddress(input: string, base: string): PreviewAddress | null {
  const text = input.trim()
  if (!text) return null
  const absolute = parseAbsolute(text)
  if (absolute) return admit(absolute)
  let baseUrl: URL
  try {
    baseUrl = new URL(base)
  } catch {
    return { refused: REFUSED }
  }
  const fromRoot = baseUrl.protocol === 'koda-preview:' && !/^(\.{1,2}\/|\/)/.test(text)
  try {
    return admit(new URL(fromRoot ? `/${text}` : text, baseUrl))
  } catch {
    return { refused: REFUSED }
  }
}

/** The input as an absolute URL, or null when it should be read as a path. `localhost:5173/x` is a
 *  scheme-less path to the URL parser (it takes `localhost` for the scheme), so that shape is caught. */
function parseAbsolute(text: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)
      ? `http://${text}`
      : null
  if (!withScheme) return null
  try {
    return new URL(withScheme)
  } catch {
    return null
  }
}

function admit(url: URL): PreviewAddress {
  if (url.protocol === 'koda-preview:') return { url: url.href }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname)) {
    return { url: url.href }
  }
  return { refused: REFUSED }
}
