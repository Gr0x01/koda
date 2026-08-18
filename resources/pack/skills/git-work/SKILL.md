---
name: git-work
description: Manage repository fit and closure for a task that will change files. Use before the first code write in a Git project, when branching or worktrees matter, when committing task-owned changes, or when merging completed work. Do not use for read-only code discussion or a document-only task unless Git operations are actually needed.
user-invocable: false
---

# Git Work

Keep the task's changes isolated, recoverable, and attributable without sweeping up work that was already there.

## Fit the work before editing

1. Inspect the current branch, status, remotes, and worktrees. Read any project-specific repository map before branch, push, publish, or release work.
2. Continue in the current branch/worktree when it already belongs to this workstream. For materially different work, create a short human-named topic branch from the repository's main branch before the first substantive edit.
3. Use a separate worktree when the current checkout belongs to another topic or may be in use. If that relationship is genuinely unclear, ask once because the answer changes where the work lands.
4. Never run destructive Git without explicit approval: no force-push, hard reset, history rewrite, tag deletion, or force-deletion of unmerged work.

## Close only this task

- After proportional verification and review, commit every task-owned change in one or more clear logical commits. An explicit user request not to commit overrides this.
- Never include pre-existing or unrelated changes. Prefer path-scoped commits and inspect the staged diff before committing.
- If the repository is absent, do not initialize one automatically. For work the user would hate to lose, offer a permanent snapshot in their terms.
- The user decides when to push, publish, merge, discard, or spend credentials. A local commit is not permission for any of those actions.
- If a side branch is merged back, remove its fully merged worktree and safely delete the branch with `git branch -d`. If safe deletion refuses, stop: unmerged work remains.
- Re-check status at the end and report the task's state truthfully. "This task is committed" is not the same claim as "the whole worktree is clean."
