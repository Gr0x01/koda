import { lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { GUIDELINES_FILES } from '@shared/ipc'
import { log } from './logger'

/**
 * Both engines should read ONE project guide. Intake authors `AGENTS.md` and links `CLAUDE.md` to it;
 * this heal covers every project from before that convention, and any intake where the link step got
 * skipped: when exactly one of the pair exists, create the missing name as a relative symlink to the
 * existing one, so switching engines never lands on a project whose guide only the other engine reads.
 *
 * Runs at project open, idempotent, and never overwrites: both real files present ⇒ untouched (they
 * may be deliberately distinct), neither present ⇒ intake's job, not this one. Presence is lstat, not
 * existsSync — a dangling symlink must count as "present" so nothing gets clobbered.
 */
export function healGuidelinesPair(root: string): 'linked' | 'noop' {
  const entry = (name: string): ReturnType<typeof lstatSync> | null => {
    try {
      return lstatSync(join(root, name))
    } catch {
      return null
    }
  }
  const [a, b] = GUIDELINES_FILES
  const statA = entry(a)
  const statB = entry(b)
  if ((statA === null) === (statB === null)) return 'noop'
  const [existing, existingStat, missing] = statA ? [a, statA, b] : [b, statB!, a]
  // A lone symlink is never a heal source. The dangerous case: CLAUDE.md → AGENTS.md survives while
  // the real AGENTS.md is gone (deleted guide, branch switch, interrupted intake). Linking back would
  // make a two-symlink loop where BOTH names ELOOP — unreadable, unwritable, unfixable by this user.
  // Left alone, existsSync sees no guide, intake re-offers, and the agent's fresh AGENTS.md write
  // resolves the dangling link naturally.
  if (existingStat.isSymbolicLink()) return 'noop'
  try {
    // Relative target: the pair sits in the same directory, and the project may move or sync.
    symlinkSync(existing, join(root, missing))
    log.info('guidelines', `linked ${missing} → ${existing}`, { root })
    return 'linked'
  } catch {
    // Read-only volume or a concurrent create — the project still works with the one file it has.
    return 'noop'
  }
}
