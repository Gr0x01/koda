import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  StageLinkTargetSchema,
  StageWorkspacePathSchema,
  type StageLinkTarget,
} from '@shared/ipc'
import { containedReal } from './fs-browse'

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

const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path)
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
    requested === 'auto' ? (args.line !== undefined ? 'file' : isMarkdown(absolutePath) ? 'document' : 'file') : requested
  if (args.line !== undefined && view !== 'file') throw new Error('line and column require the file view')
  if (view === 'document' && !isMarkdown(absolutePath)) throw new Error('document view requires Markdown')

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

/** Resolve an assistant Markdown href against a main-owned workspace root. Exact filenames win over
 * `:line[:column]` parsing so a real `notes:12` file remains reachable. */
export function resolveStageLink(root: string, href: string): StageLinkTarget {
  const candidate = hrefCandidate(href)
  if (!candidate) return { kind: 'declined' }

  const exact = tryFile(root, candidate)
  if (exact) return exact

  if (candidate.line === undefined) {
    const suffix = candidate.path.match(/^(.*):(\d+)(?::(\d+))?$/)
    if (suffix?.[1]) {
      const located = tryFile(root, {
        path: suffix[1],
        line: Number(suffix[2]),
        ...(suffix[3] ? { column: Number(suffix[3]) } : {}),
      })
      if (located) return located
    }
  }

  return { kind: 'missing', reason: "Koda couldn't find that file in this workspace." }
}
