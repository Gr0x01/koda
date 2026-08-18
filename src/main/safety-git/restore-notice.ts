/**
 * What the agent is told when safety-git moves a project's files under a live conversation.
 *
 * Both restore doors use this one text so the agent learns one rule: the UI door (Settings →
 * Recovery) queues `restoreNotice` onto each affected session's next turn, and the agent's own
 * `restore_checkpoint` gets `REREAD_AFTER_RESTORE` back in the tool result. Without it the engine
 * keeps reasoning from a transcript describing files that no longer exist on disk (dual-git.md §2).
 */
import type { Checkpoint } from './checkpoint'

/** The instruction itself, identical on both doors. */
export const REREAD_AFTER_RESTORE =
  'Any file you read or wrote earlier in this conversation may now hold different content or be gone. Re-read a file before you edit it, never edit from memory, and do not assume a change you made after that checkpoint still exists.'

function checkpointTime(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The notice that rides ahead of an affected session's next turn. `target` is the checkpoint the
 * tree was taken back to; null when its subject could not be read (a pruned or unreadable sha),
 * which still leaves the re-read instruction intact.
 */
export function restoreNotice(target: Pick<Checkpoint, 'label' | 'createdAt'> | null): string {
  const when = target
    ? `the checkpoint from ${checkpointTime(target.createdAt)} ("${target.label}")`
    : 'an earlier checkpoint'
  return `[Koda] This project's files were restored to ${when}. The restore happened outside this conversation, so the files on disk no longer match what you have seen here. ${REREAD_AFTER_RESTORE}`
}
