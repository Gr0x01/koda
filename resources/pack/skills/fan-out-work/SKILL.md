---
name: fan-out-work
description: Delegate independent parts of a task to bounded leaf agents. Use when two or more independent research, inspection, comparison, implementation, or verification lanes can make material progress in parallel, or when the user explicitly asks for subagents, delegation, parallel work, or a fan-out strategy. Fresh review alone routes through review-work, not this skill.
user-invocable: false
---

# Fan Out Work

Use subagents only where independent work can make material progress in parallel. A second opinion by
itself is finishing/review work, not a fan-out task.

1. Split along genuinely independent boundaries. Keep dependent reasoning and final integration in the parent.
2. Give each child a bounded assignment, the minimum context it needs, the evidence location, and an explicit instruction not to delegate. Ask for outcome, evidence, files touched, checks run, and unresolved issues.
3. When the fan-out spans more than one wave of children, or its lanes could outlive the current context, create a ledger at `.koda/progress/<work-slug>.md` whose first line states the work in one sentence. On returning to the work, trust the ledger over recollection; a ledger whose first line states different work is not yours to continue.
4. Start all selected read-only children before waiting. Use as many as the workstreams justify and the runtime has available; do not target a ceremonial count.
5. Choose the engine's real execution model:
   - With named Koda specialists, use `scout` for read-only investigation, `worker` only for an independent implementation in an isolated Git-backed worktree, and `critic` or `code-reviewer` for fresh judgment.
   - With generic shared-tree children, keep concurrent work read-only. If one child may mutate the tree or run a check that writes files, run exactly that one and pause parent edits until it finishes.
6. Keep the parent conversation available while background work runs. Stop only the child that is no longer useful.
7. Treat every child summary as a lead. Inspect its evidence and rerun the decisive check before using the result or calling the work finished. Record a lane in the ledger only after that inspection passes; dispatch alone records nothing.

The parent owns synthesis, edits to the main worktree, and the final answer. Never auto-merge a worker
candidate. Delete the ledger when the work is delivered; the recap and project history are the durable
record.
