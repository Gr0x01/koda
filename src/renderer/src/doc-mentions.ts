export type MentionDoc = { rel: string; name: string }

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
