import { useCallback, type ReactNode } from 'react'
import { LocalLinkContext } from '../output/Markdown'
import { useWorkspace } from './store'

/**
 * Desktop-only: makes local-file links inside assistant markdown open in the Stage
 * (the same openFile path the Files tree uses) instead of the browser. The agent
 * often writes a doc and links it in its reply — that link's href is a project path,
 * which in a dev build would otherwise resolve to a localhost URL and open the
 * browser. Here it lands as a doc surface. Web links are untouched (see MarkdownLink).
 */
export function StageLinkProvider({ children }: { children: ReactNode }) {
  const openFile = useWorkspace((s) => s.openFile)
  const projectPath = useWorkspace((s) => s.projectPath)

  const handle = useCallback(
    (href: string): boolean => {
      const abs = resolveInProject(href, projectPath)
      if (!abs) return false
      openFile(abs)
      return true
    },
    [openFile, projectPath],
  )

  return <LocalLinkContext.Provider value={handle}>{children}</LocalLinkContext.Provider>
}

/**
 * Resolve a markdown href to an absolute path inside `root`, or null if it isn't a
 * local file we should claim (leaving it to fall back to window.open). Handles
 * file:// URLs, absolute paths, and root-relative paths (how the agent writes doc
 * links). Anything resolving outside the project is declined.
 */
function resolveInProject(href: string, root: string | null): string | null {
  if (!root) return null
  let p = href
  if (p.startsWith('file://')) {
    try {
      p = new URL(p).pathname
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) {
    // Any other URL scheme (http, mailto, data, javascript…) is not a local file.
    return null
  }
  // Drop any in-doc anchor / query the shell wouldn't understand, then decode
  // percent-escapes (a `Build%20plan.md` href maps to a real space on disk).
  p = decode(p.split('#')[0].split('?')[0])
  if (!p) return null

  const abs = normalize(p.startsWith('/') ? p : `${root}/${p}`)
  // Stay inside the project — never let a link reach elsewhere on disk.
  return abs === root || abs.startsWith(root + '/') ? abs : null
}

function decode(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p // a literal % that isn't a valid escape — take the path as-is
  }
}

/** Collapse `.` / `..` segments in a POSIX path (no fs access in the renderer). */
function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}
