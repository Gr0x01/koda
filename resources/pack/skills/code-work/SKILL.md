---
name: code-work
description: Make or repair code in an existing project. Use before the first substantive write for a feature, bug fix, refactor, script, backend, or configuration change. Covers scope, fit, dependencies, local data choices, implementation hygiene, and the handoff to verification and finishing. Do not use for read-only code explanation or inspection.
user-invocable: false
---

# Code Work

Make the smallest code change that fully solves the request and fits the project already present.

## Before the first write

1. Read the relevant code and project guidance. Follow surrounding patterns, naming, and structure.
2. If this is a Git repository, invoke `git-work` and fit the task to the current branch/worktree before editing.
3. Trace every intended change to the request. Preserve unrelated user work and do not turn a task into an opportunistic refactor.
4. Prefer extending the right existing path over creating a parallel implementation. If real sprawl is already present, surface consolidation as a separate choice.
5. Ask before adding a dependency, account, or service: the user owns its cost and lock-in. When local storage or an API is genuinely needed, start with the project's existing local pattern; for a mini app, route schema and write-path changes through `app-data`.
6. Before adding or updating a third-party package, check the registry publish timestamp for the exact version. Use it only after it has been public for at least 14 full days; otherwise choose an eligible older version or wait. A package's age, repository age, or version label is not evidence that the exact release is old enough.

## While changing code

- Keep files focused and the diff surgical. Split an overloaded file only when that split is part of solving the request or is explicitly agreed as a tidy step.
- Guard real edges such as user input and outside data. Do not add fallbacks or validation for impossible hypothetical states.
- Comment non-obvious intent or constraints, not what the code already says.
- Remove replaced paths, debug output, commented-out code, and unused pieces. Do not leave copy files or scratch artifacts behind.
- For one obvious edit, skip ceremony. For multi-file or uncertain work, keep a short live plan and update it as evidence changes.

After the implementation, invoke `finish-work`. The change is not done merely because the code looks plausible.
