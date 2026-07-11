import { Markdown } from '../output/Markdown'

/**
 * One finalized assistant block. Rendered as real HTML, so the re-targetable copy
 * the output view exists for is just native selection + ⌘C: highlighting a section
 * and copying puts both `text/html` (formatted for Docs/Gmail/Notion) and clean
 * `text/plain` (no `**`/`#`) on the clipboard — no toolbar needed.
 */
export function AssistantMarkdown({ markdown }: { markdown: string }) {
  return <Markdown>{markdown}</Markdown>
}
