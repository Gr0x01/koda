export type MentionDoc = {
  /** Project-relative POSIX path — what expansion writes into the text the engine reads. */
  rel: string
  /** The filename, extension included — the label rule below is what strips it. */
  name: string
  /** Absolute path: this document's IDENTITY, not a location to display. Two references are the same
   *  document when this matches. */
  path: string
}

/** The one user-facing label rule shared by the picker and send-time path expansion. */
export function docMentionLabel(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** Spaces need a boundary that survives the composer's plain text draft. */
export function docMention(label: string): string {
  return /[\s"\\]/.test(label) ? `@"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `@${label}`
}

const LABEL_MENTION_RE = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s/]+))/g

/** Turn the composer's readable labels back into exact project-relative paths for the agent. */
export function expandDocMentionLabels(text: string, docs: MentionDoc[]): string {
  const byLabel = new Map<string, string>()
  for (const doc of docs) {
    const label = docMentionLabel(doc.name)
    if (!byLabel.has(label)) byLabel.set(label, doc.rel)
  }
  return text.replace(LABEL_MENTION_RE, (match, prefix: string, quoted: string | undefined, bare: string | undefined) => {
    const label = quoted?.replace(/\\(["\\])/g, '$1') ?? bare ?? ''
    const rel = byLabel.get(label)
    return rel ? `${prefix}${docMention(rel)}` : match
  })
}

/** Wider than `LABEL_MENTION_RE` on purpose: this one also catches a token containing a slash, which
 *  expansion deliberately leaves alone because the user already typed a path. Expansion's job is to
 *  rewrite; this one's is to see whether the draft points at anything at all. Matches the composer's
 *  own ink layer (`inkTokens`), so a glyph painted as a reference is one this gate can see. */
const ANY_MENTION_RE = /(?:^|\s)@("(?:\\.|[^"\\])*"|\S+)/g

/** Every `@`-token in a draft, unquoted, in the order typed. */
function mentionTokens(text: string): string[] {
  const out: string[] = []
  for (const [, token] of text.matchAll(ANY_MENTION_RE)) {
    out.push(
      token.length > 1 && token.startsWith('"') && token.endsWith('"')
        ? token.slice(1, -1).replace(/\\(["\\])/g, '$1')
        : token,
    )
  }
  return out
}

/** Whether a draft points at anything at all — the cheap test before paying for the document list. */
export function hasDocMention(text: string): boolean {
  return text.includes('@') && mentionTokens(text).length > 0
}
