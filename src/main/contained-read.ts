/**
 * Open a project file without letting a cached lexical path turn into a symlink escape between the
 * directory walk and the later read. Validation is against the SAME open file descriptor that will
 * be read: the opened inode is compared with the contained realpath after open, so a leaf or parent
 * swapped between the two either resolves outside the root or names a different inode; in both cases
 * the descriptor is closed before a byte is read.
 *
 * A symlink is FOLLOWED, not refused. Containment is decided by where a path RESOLVES, never by
 * whether its leaf happened to be a link: Koda writes a `CLAUDE.md` → `AGENTS.md` link itself, the
 * Files tree lists a link as an ordinary row, and refusing the class made those rows unopenable while
 * `containedReal` (writes, phone excerpts) went on resolving them — two surfaces, one file, two
 * answers.
 */
import { constants, realpathSync, statSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

interface OpenedContainedFile {
  handle: FileHandle
  path: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export async function openContainedRegularFile(root: string, file: string): Promise<OpenedContainedFile> {
  const realRoot = realpathSync(root)
  const candidate = resolve(realRoot, file)
  let fh: FileHandle | undefined
  try {
    // `O_NONBLOCK` is what keeps the non-regular refusal below reachable: opening a FIFO without it
    // parks forever waiting for a writer, and the check that would reject it never runs. It is inert
    // on the regular files this actually serves.
    fh = await open(candidate, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const opened = await fh.stat()
    if (!opened.isFile()) throw new Error('not a regular file')

    const resolved = realpathSync(candidate)
    if (!isContained(realRoot, resolved)) throw new Error('path escapes project root')
    const named = statSync(resolved)
    if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino)
      throw new Error('path changed while it was being opened')
    return {
      handle: fh,
      path: resolved,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    }
  } catch (err) {
    await fh?.close().catch(() => {})
    throw err
  }
}

export async function readContainedRegularFile(
  root: string,
  file: string,
  maxBytes: number,
  /** Deterministic mutation seam for the race regression test; production callers omit it. */
  afterOpen?: () => void | Promise<void>,
): Promise<{ bytes: Buffer; truncated: boolean; path: string }> {
  const opened = await openContainedRegularFile(root, file)
  const fh = opened.handle
  try {
    await afterOpen?.()
    // Do not trust the pre-read size to choose how much to read: a file that grows after fstat would
    // otherwise return the old prefix while claiming it was complete. One sentinel byte distinguishes
    // an exact/capped read independently of that snapshot.
    const wanted = Math.max(0, maxBytes) + 1
    const buf = Buffer.alloc(wanted)
    let bytesRead = 0
    // POSIX permits a successful short read before EOF (network/FUSE/cloud-backed project roots do
    // this in practice), so fill the bounded buffer rather than treating one syscall as the file.
    while (bytesRead < wanted) {
      const chunk = await fh.read(buf, bytesRead, wanted - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    await assertUnchanged(opened)
    return {
      bytes: buf.subarray(0, Math.min(bytesRead, maxBytes)),
      truncated: bytesRead > maxBytes,
      path: opened.path,
    }
  } finally {
    await fh.close()
  }
}

/** Read the complete contents through the same descriptor containment was proved against. Static
 * previews need the whole asset (unlike capped editor/search reads), but they must not fall back to a
 * validate-path-then-reopen sequence: a leaf or parent swapped in that gap could otherwise redirect
 * the privileged preview protocol outside the project. */
export async function readWholeContainedRegularFile(
  root: string,
  file: string,
): Promise<{ bytes: Buffer; path: string }> {
  const opened = await openContainedRegularFile(root, file)
  try {
    const bytes = await opened.handle.readFile()
    await assertUnchanged(opened)
    return { bytes, path: opened.path }
  } finally {
    await opened.handle.close()
  }
}

/** A same-inode read can still be internally inconsistent when another writer changes the file while
 * its bytes are being copied. Size catches growth/truncation; mtime/ctime catch same-size rewrites. */
async function assertUnchanged(opened: OpenedContainedFile): Promise<void> {
  const after = await opened.handle.stat()
  if (
    !after.isFile() ||
    after.size !== opened.size ||
    after.mtimeMs !== opened.mtimeMs ||
    after.ctimeMs !== opened.ctimeMs
  )
    throw new Error('file changed while it was being read')
}
