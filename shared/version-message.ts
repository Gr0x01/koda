/**
 * The deterministic floor for a saved version's description — the sentence Koda writes when no model
 * does. Shared because BOTH sides need the identical string: the renderer seeds the save composer
 * with it the instant the user opens it (so the Save button is never disabled waiting on a
 * generation), and main returns it as the answer whenever the engine one-shot is off, unreachable, or
 * unusable. Two copies of this would drift into the composer proposing one thing and a missed
 * generation replacing it with a differently-worded other, which reads as the field changing by
 * itself.
 *
 * Pure and dependency-free: no git, no engine, no Electron.
 */

/** The shape both sides already hold (renderer: GitStatusFile; main: StatusFile). */
export interface VersionMessageFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'other'
}

/** One provider-neutral saved-version subject. Both Apple and Claude pass through this exact gate so
 *  changing provider cannot change whether a refusal, body, label, or run-on reaches project history. */
export function cleanVersionSubject(raw: string): string | null {
  const source = raw.trim()
  if (!source || /[\n\r]/.test(source)) return null
  const text = source
    .replace(/[ \t]+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^(subject|commit message|message)\s*:\s*/i, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s*—\s*/g, ', ')
    .trim()
  if (!text || text.length > 120 || text.split(/\s+/).length > 18) return null
  if (
    /\b(i'?m sorry|i apologi[sz]e|i cannot|i can'?t|i can not|as an ai|as a (chat)?bot|as a language model|cannot (comply|assist|fulfil|help)|imperative mood|no quotes|json only|trailing punctuation)\b/i.test(
      text,
    )
  )
    return null
  return text
}

/** Imperative verb for a set of changes, so the floor reads like a description rather than a count. */
function verbFor(files: VersionMessageFile[]): string {
  const kinds = new Set(files.map((f) => (f.status === 'untracked' ? 'added' : f.status)))
  if (kinds.size === 1) {
    const [only] = [...kinds]
    if (only === 'added') return 'Add'
    if (only === 'deleted') return 'Delete'
    if (only === 'renamed') return 'Rename'
  }
  return 'Update'
}

/** The directory every path shares, '' when they don't share one. Used only to make the floor more
 *  specific ("in src/main"); a repo-root-wide change says nothing extra. */
function commonDir(files: VersionMessageFile[]): string {
  const dirs = files.map((f) => f.path.split('/').slice(0, -1))
  if (dirs.length === 0) return ''
  let shared = dirs[0]
  for (const dir of dirs.slice(1)) {
    let i = 0
    while (i < shared.length && i < dir.length && shared[i] === dir[i]) i++
    shared = shared.slice(0, i)
    if (shared.length === 0) return ''
  }
  return shared.join('/')
}

/**
 * A plain, honest one-line description of a change set. Never empty, never invented: it says what
 * changed and where, and nothing about why (which only a model or the user can know).
 *
 * `truncated` means the caller's file list was clipped by the status cap, so the count is a floor and
 * is stated as such rather than as a fact that is quietly wrong.
 */
export function fallbackVersionMessage(files: VersionMessageFile[], truncated = false): string {
  if (files.length === 0) return 'Save the current changes'
  if (files.length === 1 && !truncated) return `${verbFor(files)} ${files[0].path}`
  const count = truncated ? `${files.length}+` : `${files.length}`
  const dir = commonDir(files)
  return `${verbFor(files)} ${count} files${dir ? ` in ${dir}` : ''}`
}
