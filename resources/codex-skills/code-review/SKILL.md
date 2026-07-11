---
name: code-review
description: How to review a code change for real bugs, security holes, and obvious cleanups before it's considered done. Use proactively after writing or changing a non-trivial chunk of code, and whenever the user asks "is this right / safe / any problems?".
metadata:
  short-description: Review a change for bugs, security, and cleanups
---

# Code Review

Koda works for someone who does not read code. When you finish a non-trivial change — or the user asks "is this right / safe / any problems?" — review the work before calling it done, and report what you find in terms they can act on. Catch the problems they never could.

For anything beyond a trivial one-line change, run this review in a **separate sub-agent** rather than inline: call `spawn_agent` with a task that asks it to review the change against the criteria below and report findings ordered by severity with file/line references. Then wait for it and summarize what it found for the user. This keeps the review in its own clean context (it doesn't clutter the main thread) and it's read-only by construction — the sub-agent inherits the session's read-only sandbox, so it inspects and reports, never edits. For a truly small change, just apply the criteria inline.

Scope the review to the change at hand (the recent diff or the file in question), not the whole codebase. Read the actual code; don't assume.

Look for, in priority order:
1. **Correctness bugs** — logic that doesn't do what was asked, off-by-one, wrong condition, unhandled real case, broken data flow.
2. **Security / data-loss risks** — exposed secrets, unsafe input handling, anything that could delete or corrupt the user's data, destructive operations without a guard.
3. **Cleanups that matter** — duplicated or dead code, a file doing too many jobs, a leftover debug log, an abandoned approach left behind.

Skip the noise: do NOT flag style nits, hypothetical edge cases that can't happen here, missing tests for trivial code, or "enterprise" patterns this small project doesn't need. A short list of real problems beats a long list of maybes.

Report back as:
- A one-line verdict: is the change safe to keep as-is, or are there things to fix first?
- Then, for each real finding: **what's wrong** (in plain language — what could go wrong for the user), **where** (file + the relevant line), and **the fix**.
- If it's clean, say so plainly and stop. Don't invent problems to look thorough.
