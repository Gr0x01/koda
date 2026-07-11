/**
 * Prose copy is native: rendered markdown is real HTML, so selecting + ⌘C already
 * emits both `text/html` (rich) and clean `text/plain`. The only explicit copy left
 * is the code-fence "Copy" button, which grabs the raw snippet for pasting into a file.
 *
 * Renderer-only (navigator.clipboard).
 */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
