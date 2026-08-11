---
name: fan-out-work
description: Delegate independent parts of a task to parallel Codex subagents and synthesize their evidence safely. Use when a request has two or more independent research, inspection, review, comparison, or verification workstreams; when a substantial task benefits from fresh specialist judgment; or when the user asks for subagents, delegation, parallel work, or a fan-out strategy.
---

# Fan Out Work

Use collaboration subagents when independent workstreams make them materially useful.

1. Split the task only along genuinely independent boundaries. Keep dependent work in the parent.
2. Give each child a bounded assignment and an arbitrary task-specific specialty. Ask it to return its outcome, evidence, files touched, checks run, and unresolved issues.
3. Use as many children as the workstreams justify and the runtime has available; do not target a fixed count. Start all selected read-only children before waiting for any of them. Do not spawn and wait one-by-one when the assignments are independent.
4. Keep concurrent children read-only because Codex children share the project tree. If one child may edit files or run a check that writes files, run exactly that one child and pause parent edits until it finishes.
5. Tell every child not to delegate. Flatness is an instruction, not a separate permission boundary.
6. Keep the parent available while children run. Stop only the child whose work is no longer useful.
7. Inspect returned evidence and rerun the relevant checks before acting on a child result or calling the work finished.

The parent owns synthesis and the final answer. A child summary is a lead, never proof by itself.
