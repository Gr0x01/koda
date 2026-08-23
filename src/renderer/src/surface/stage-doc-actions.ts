/**
 * The document-scoped Stage-bar actions, as pure decisions kept out of the React tree so they can be
 * tested in plain Node (the renderer suite has no DOM). `stagedDocRel` is the one answer to "is a real,
 * keepable document staged, and by what project-relative path?" — the Stage bar uses it for both the
 * project-owned star and the document-only overflow/view hierarchy.
 */
import { resolveDocFormat } from '@shared/document-contract'
import type { DocFormat } from '@shared/ipc'
import type { FileSurface } from '../workspace/store'

/** Formats that have a rendered document view on the Stage — the ones whose "Doc" toggle cell exists at
 *  all. `resolveDocFormat` owns which extension is which; this names what the Dock can currently show. */
export const hasDocView = (format: DocFormat): boolean => format === 'markdown' || format === 'html'

/**
 * The project-relative path to star for the currently staged surface, or null when there is nothing
 * keepable on stage.
 *
 * The shelf's stars are project-relative document paths, so the action exists only for a
 * document-format file tab (not a preview/terminal/changes singleton, and not a non-document file)
 * that lives inside the open project. The star command itself is format-blind — it stars a contained
 * path — so widening `hasDocView` is all a new document format needs to become keepable from here.
 */
export function stagedDocRel(staged: FileSurface | null, projectPath: string | null): string | null {
  if (!staged || staged.kind || !projectPath) return null
  if (!hasDocView(resolveDocFormat(staged.path))) return null
  const prefix = `${projectPath}/`
  return staged.path.startsWith(prefix) ? staged.path.slice(prefix.length) : null
}
