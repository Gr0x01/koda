---
name: finish-work
description: Close material work after files or a user-visible artifact changed. Use before delivery to choose proportional verification, cleanup, Git closure, and a truthful recap. Skip for pure conversation, read-only inspection, trivial mechanical edits, or when there is nothing inspectable yet.
user-invocable: false
---

# Finish Work

Finish the actual task, not the entire surrounding worktree. Set the finish line from the requested
behavior and its smallest credible proof; do not turn a bounded change into a release program.

1. **Identify the task artifact.** Separate task-owned changes from pre-existing or unrelated work. If the turn made no material artifact, stop; this playbook has nothing to do.
2. **Verify proportionally.** Invoke `verify` for runnable changes and `browser-verify` for an interactive web flow. Start with the narrowest check that exercises the changed behavior. After a repair, rerun only the proof that repair invalidated; do not restart a broad suite or device/browser matrix by habit. If verification cannot run, say so and do not claim the work is proven.
3. **Spend at most one review pass.** When the ambient review route is present, skip fresh review for trivial, mechanical, or low-risk work. For a non-trivial bounded change or an inspectable artifact with a real bar, invoke `review-work` once and choose its one matching lane. A finding may lead to an in-scope repair and targeted verification, never another reviewer or a restarted review stack. Authentication, remote trust, encryption, destructive or data-loss paths, migrations, and concurrency/lifecycle ownership still earn one ordinary internal pass. Deep Review is a separate, explicit user-invoked workflow and is never automatic finishing debt.
4. **Leave only intentional state.** Remove task scratch files, dead alternatives, debug output, and half-finished paths. Name any deliberate gap in one plain line.
5. **Present the primary result.** When a material file is the best inspectable artifact and Koda's
   live capability directory exposes Stage, call `mcp__koda_broker__present_file` once after the last
   relevant change. Let Markdown open as a document; name a line and column for source when that is the
   useful landing point; use the existing preview route for a running app or HTML presentation. This is
   the visible handoff, not a substitute for verification. In the final reply, link the real local file
   as well so the route remains in the conversation.
6. **Keep the project guide true.** If the work changed something the project's guidance file (`AGENTS.md`/`CLAUDE.md`) asserts — a decision, a constraint, what exists, where things live — update that file now, as part of the close. A guide describing yesterday's reality misleads every later session, and nobody else will notice it drifted. If nothing it asserts changed, move on.
7. **Close versioned work.** If this was code in an existing Git repository, return to `git-work` and commit only task-owned changes unless the user explicitly stood that down.
8. **Recap truthfully, in a few lines.** What changed, where the user will see it, what the check proved, and anything you changed beyond the ask — a line each at most, and only the lines that are true and not already visible on their screen. Distinguish task closure from aggregate worktree cleanliness. The recap carries what the user cannot see for themselves; it is not a report proving the work happened, and padding it into one is the failure here.

Do not invent a review finding, a passing check, or a clean state. A short honest limitation is better than a false completion claim.
