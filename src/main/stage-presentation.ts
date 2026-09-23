import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  StageLinkTargetSchema,
  StageWorkspacePathSchema,
  type StageLinkTarget,
} from '@shared/ipc'
import { resolveDocFormat } from '@shared/document-contract'
import { containedReal, HIDDEN_DIRS } from './fs-browse'

export type PresentFileView = 'auto' | 'document' | 'file' | 'diff'

export interface PresentFileArgs {
  path: string
  view?: PresentFileView
  line?: number
  column?: number
}

export interface PreparedPresentation {
  path: string
  absolutePath: string
  view: Exclude<PresentFileView, 'auto'>
  line?: number
  column?: number
}

/**
 * Whether the agent's `document` view exists for this path. One predicate with the renderer's: the
 * Stage resolves the same file to the same surface whether a person opened it or the agent presented
 * it, so `present_file` can no longer promise a rich view the Dock would not give.
 *
 * This is a deliberate narrowing for `.mdx` (Slice 0 decision, 2026-08-20): it used to qualify here
 * while the Dock opened it as raw source, so the agent could ask for a document view of a file the
 * user's own double-click never rendered. It is a widening for `.html`, which now has a real
 * (sandboxed) document surface.
 */
const hasDocumentView = (path: string): boolean => {
  const format = resolveDocFormat(path)
  return format === 'markdown' || format === 'html'
}
const posix = (path: string): string => path.split(sep).join('/')

function relativeIdentity(root: string, absolutePath: string): string {
  const rel = posix(relative(containedReal(root), absolutePath))
  return StageWorkspacePathSchema.parse(rel)
}

/** Validate and normalize the explicit agent presentation request at the main-process boundary. */
export function preparePresentFile(root: string, args: PresentFileArgs): PreparedPresentation {
  const portablePath = StageWorkspacePathSchema.parse(args.path)
  if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1))
    throw new Error('line must be a positive integer')
  if (args.column !== undefined && (!Number.isInteger(args.column) || args.column < 1))
    throw new Error('column must be a positive integer')
  if (args.column !== undefined && args.line === undefined) throw new Error('column requires line')

  const absolutePath = containedReal(root, portablePath)
  if (!statSync(absolutePath).isFile()) throw new Error('path must name a file')
  const requested = args.view ?? 'auto'
  const view: PreparedPresentation['view'] =
    requested === 'auto'
      ? args.line !== undefined
        ? 'file'
        : hasDocumentView(absolutePath)
          ? 'document'
          : 'file'
      : requested
  if (args.line !== undefined && view !== 'file') throw new Error('line and column require the file view')
  if (view === 'document' && !hasDocumentView(absolutePath))
    throw new Error('document view requires a Markdown or HTML document')

  return {
    path: relativeIdentity(root, absolutePath),
    absolutePath,
    view,
    ...(args.line !== undefined ? { line: args.line } : {}),
    ...(args.column !== undefined ? { column: args.column } : {}),
  }
}

type Candidate = { path: string; line?: number; column?: number }

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function hrefCandidate(href: string): Candidate | null {
  let raw = href.trim()
  if (!raw || raw.startsWith('#')) return null

  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw)
      const match = url.hash.match(/^#L(\d+)(?:C(\d+))?$/i)
      return {
        path: decodePath(url.pathname),
        ...(match ? { line: Number(match[1]) } : {}),
        ...(match?.[2] ? { column: Number(match[2]) } : {}),
      }
    } catch {
      return null
    }
  }

  // A path-location such as `src/a.ts:12` resembles a URL scheme. Preserve it until after the
  // numeric suffix has been considered; real web/custom schemes are declined below.
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  if (hashAt >= 0) raw = raw.slice(0, hashAt)
  const queryAt = raw.indexOf('?')
  if (queryAt >= 0) raw = raw.slice(0, queryAt)
  const hashLocation = hash.match(/^#L(\d+)(?:C(\d+))?$/i)
  const path = decodePath(raw)
  if (!path) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/:\d+(?::\d+)?$/.test(path)) return null
  return {
    path,
    ...(hashLocation ? { line: Number(hashLocation[1]) } : {}),
    ...(hashLocation?.[2] ? { column: Number(hashLocation[2]) } : {}),
  }
}

function lexicalEscape(root: string, requested: string): boolean {
  const absolute = resolve(root, requested)
  const rel = relative(resolve(root), absolute)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function tryFile(root: string, candidate: Candidate): StageLinkTarget | null {
  if (lexicalEscape(root, candidate.path)) return { kind: 'declined', reason: 'That link is outside this workspace.' }
  if (!existsSync(resolve(root, candidate.path))) return null
  try {
    const absolutePath = containedReal(root, candidate.path)
    if (!statSync(absolutePath).isFile()) return { kind: 'missing', reason: 'That link does not name a file.' }
    return StageLinkTargetSchema.parse({
      kind: 'file',
      path: relativeIdentity(root, absolutePath),
      absolutePath,
      ...(candidate.line !== undefined ? { line: candidate.line } : {}),
      ...(candidate.column !== undefined ? { column: candidate.column } : {}),
    })
  } catch {
    return { kind: 'declined', reason: 'That link leaves this workspace.' }
  }
}

/** Bounded so a click can never walk an enormous tree synchronously. A project past this is already
 *  past what the Files tree and project search enumerate. */
const LINK_SEARCH_MAX_FILES = 20_000

/** Every file in the workspace as a posix path relative to `root`. Same universe as `searchProject`:
 *  hidden/noise dirs skipped, symlinked dirs never followed. */
function workspaceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    if (found.length >= LINK_SEARCH_MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip it rather than abandoning the search
    }
    for (const entry of entries) {
      if (found.length >= LINK_SEARCH_MAX_FILES) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (HIDDEN_DIRS.has(entry.name)) continue
        walk(resolve(dir, entry.name), `${prefix}${entry.name}/`)
      } else if (entry.isFile()) {
        found.push(`${prefix}${entry.name}`)
      }
    }
  }
  walk(resolve(root), '')
  return found
}

/**
 * The forgiving second pass, for a link whose literal path does not exist here.
 *
 * An agent writes chat links the way it writes links inside a document: relative to the folder it was
 * thinking in. So `../../art/review/world_studies/README.md` and a bare `domain.json` are both ordinary
 * and both wrong against a workspace root, which made the single most common kind of link Koda renders
 * a dead one. Chat has no base folder to be relative to, so instead of guessing one, match the link's
 * trailing segments against the workspace and take the answer only when it is unambiguous: longest tail
 * first, exactly one file, or nothing. Traversal is dropped rather than followed, and the hit is still
 * resolved through `tryFile`, so a forgiving AUTHOR never widens what a link can REACH.
 */
function searchWorkspaceForLink(root: string, candidate: Candidate): StageLinkTarget | null {
  const wanted = candidate.path.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..')
  if (!wanted.length) return null
  const files = workspaceFiles(root)
  for (let depth = wanted.length; depth >= 1; depth--) {
    const tail = `/${wanted.slice(-depth).join('/')}`
    const hits = files.filter((file) => `/${file}`.endsWith(tail))
    if (hits.length === 1) return tryFile(root, { ...candidate, path: hits[0]! })
    if (hits.length > 1)
      return {
        kind: 'missing',
        reason: 'Several files in this workspace match that link, so Koda cannot tell which one it means.',
      }
  }
  return null
}

/** Resolve an assistant Markdown href against a main-owned workspace root. Exact filenames win over
 * `:line[:column]` parsing so a real `notes:12` file remains reachable. */
export function resolveStageLink(root: string, href: string): StageLinkTarget {
  const candidate = hrefCandidate(href)
  if (!candidate) return { kind: 'declined', reason: "Koda can't open that kind of link." }

  // A `:line[:column]` suffix is a second reading of the SAME href, not a second link: both readings
  // get a literal try before either gets the forgiving one, so a real `notes:12` file still wins.
  const readings: Candidate[] = [candidate]
  if (candidate.line === undefined) {
    const suffix = candidate.path.match(/^(.*):(\d+)(?::(\d+))?$/)
    if (suffix?.[1])
      readings.push({
        path: suffix[1],
        line: Number(suffix[2]),
        ...(suffix[3] ? { column: Number(suffix[3]) } : {}),
      })
  }

  let refused: StageLinkTarget | null = null
  for (const reading of readings) {
    const literal = tryFile(root, reading)
    if (literal?.kind === 'file') return literal
    refused ??= literal
  }
  for (const reading of readings) {
    const found = searchWorkspaceForLink(root, reading)
    if (found) return found
  }

  // A link that pointed outside the workspace and matched nothing inside it keeps the truer sentence.
  return refused ?? { kind: 'missing', reason: "Koda couldn't find that file in this workspace." }
}
