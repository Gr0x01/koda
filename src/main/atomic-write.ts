/**
 * Crash-safe file persistence: write a sibling temp file, then rename it over the target. rename()
 * within one directory is atomic on APFS, so a crash or power cut mid-write leaves the PREVIOUS
 * file intact instead of a truncated one. That matters because every store here is fail-soft on
 * read — a torn JSON parses as corrupt and silently restores nothing, which for the session store
 * means a project's whole transcript history vanishes. Callers keep their own try/catch.
 */
import { renameSync, writeFileSync } from 'node:fs'

export function writeFileAtomic(path: string, data: string, opts?: { mode?: number }): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, opts)
  renameSync(tmp, path)
}
