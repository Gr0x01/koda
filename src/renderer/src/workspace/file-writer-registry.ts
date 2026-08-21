/**
 * The mounted editor for a path owns its live buffer. Filesystem mutations live in the workspace
 * store, so this tiny registry is the rendezvous between them: a delete can drain every editor under
 * its target before main checkpoints and removes the on-disk tree.
 */
export type FileWriterFlush = () => Promise<void>

type RegisteredFileWriter = {
  /** Main's resolved file identity, used for every write and destructive boundary. */
  canonicalPath: string
  /** The lexical path that keys the open Stage surface. */
  surfacePath: string
  flush: FileWriterFlush
}

const writers = new Map<string, Set<RegisteredFileWriter>>()

/**
 * Register one mounted writer. `canonicalPath` comes from main's ReadFileResult; `surfacePath` stays
 * lexical so a delete can close the exact Stage tab the user opened through an in-project alias. The
 * identity-safe cleanup removes only this registration, never a newer writer for either path.
 */
export function registerFileWriter(
  canonicalPath: string,
  surfacePath: string,
  flush: FileWriterFlush,
): () => void {
  const registration = { canonicalPath, surfacePath, flush }
  const registered = writers.get(canonicalPath) ?? new Set<RegisteredFileWriter>()
  registered.add(registration)
  writers.set(canonicalPath, registered)

  return () => {
    registered.delete(registration)
    if (registered.size === 0 && writers.get(canonicalPath) === registered) writers.delete(canonicalPath)
  }
}

/**
 * Drain the target file, or every mounted writer below a target directory. Matching either identity
 * keeps ordinary lexical tree deletes working, while a canonical document delete also finds a writer
 * opened through a symlink or differently-cased alias. Writers run serially: two views of one file
 * must never race their final write, and the first failure aborts the mutation.
 *
 * The returned lexical paths are the Stage surfaces made stale by a successful canonical delete.
 */
async function flushFileWritersMatching(
  matches: (writer: RegisteredFileWriter) => boolean,
): Promise<string[]> {
  const affectedSurfacePaths = new Set<string>()

  for (const registered of [...writers.values()]) {
    for (const writer of [...registered]) {
      if (!matches(writer)) continue
      await writer.flush()
      affectedSurfacePaths.add(writer.surfacePath)
    }
  }

  return [...affectedSurfacePaths]
}

export async function flushFileWritersUnder(target: string): Promise<string[]> {
  const root = target.replace(/\/+$/, '')
  const underTarget = (path: string): boolean => path === root || path.startsWith(`${root}/`)
  return flushFileWritersMatching((writer) => underTarget(writer.canonicalPath) || underTarget(writer.surfacePath))
}

/**
 * Drain every mounted editor before a renderer reload. Unlike a path-scoped delete, a reload tears
 * down every JavaScript-owned buffer at once; one refused save blocks that reload instead of losing
 * the only copy of recent typing.
 */
export async function flushAllFileWriters(): Promise<void> {
  await flushFileWritersMatching(() => true)
}

/**
 * Turn an editor save into a serial drain. A rejection is returned to that caller but removed from
 * the private tail, so a later retry still runs instead of inheriting the old failure forever.
 */
export function createSerialFlush(flush: FileWriterFlush): FileWriterFlush {
  let tail = Promise.resolve()
  return () => {
    const next = tail.then(flush)
    tail = next.catch(() => {})
    return next
  }
}
