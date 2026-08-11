---
name: memory
description: How to keep this project's memory in `.koda/memory/` — the index, per-note descriptions, and links between notes. Use when reading project memory to get oriented at the start of work, when writing or updating a note about how the project works, a decision, or context worth keeping for next time, or when asked to tidy or prune a memory that has grown heavy.
user-invocable: false
---

Koda keeps each project's lasting knowledge in `.koda/memory/` so you start a session already oriented instead of re-deriving everything from the files. It's plain markdown you read and maintain — there's no database, no index to rebuild.

**The index — `.koda/memory/MEMORY.md`.** One line per note, most relevant first:

```
- [Auth flow](auth-flow.md) — how login works + where the session token lives
- [Why Postgres, not Mongo](db-choice.md) — the decision and the reason behind it
```

Read it when you start. Each line's hook tells you what its note is about, so you open only the one or two you actually need — not every file. If `.koda/memory/` doesn't exist yet, create it with a `MEMORY.md` the first time you have something worth keeping.

**One note per topic.** Each note is a single `.md` file with frontmatter:

```markdown
---
name: auth-flow
description: how login works + where the session token lives
---

The fact, decision, or context — written for the next session, which remembers
nothing of this one. Link related notes inline with [[db-choice]].
```

The `description` is what powers orientation — keep it a tight one-liner; it's read far more often than the body. Link related notes with `[[slug]]` (the other note's `name`). A link to a note that doesn't exist yet is fine — it marks one worth writing later.

**What the next session actually sees.** Only two files load automatically at the start of the next session: the index (`MEMORY.md`) and `active-context.md`. Every other note is opt-in — read only if the index line makes someone open it. This decides *where* a thing goes, not just *whether* to write it:

- Something the next session must **act on** — a handoff, an open problem to pick up, an approach you just reverted so nobody rebuilds it — must be *reachable* from `active-context.md`, the one note guaranteed to be read. Reachable, not necessarily *inside* it: a single loose item sits inline, but a growing list of pending work (built-but-unverified, awaiting-deploy, open decisions) goes in its own on-demand note with a one-line pointer here. "Must not be lost" is not "must load every turn" — the pointer is the guarantee; the detail rides on-demand, so the always-loaded weight stays flat however much piles up.
- A topic fact (how a subsystem works, a decision, a gotcha) belongs in its own note — but it's invisible until an index line leads there. So writing the note isn't done until its `MEMORY.md` line exists and its hook tells the reader why they'd open it. Detail in a note + a pointer in `active-context.md` or the index is the pattern; detail in a note *alone* is a fact nobody will find.

**When to write a note.** Capture what should outlast the session: how a part of the project works, a decision and *why*, a constraint, a gotcha you hit and how you got past it. Skip transient task state, and skip anything already obvious from the code or git history — memory is for what you can't re-derive by looking. Uncommitted changes on the current branch are in that bucket: git status already shows them, so "needs committing" is not a memory entry. Work the user *can't* see from where they sit — parked on a side branch or worktree, or built but not yet deployed — is what earns a line.

**Write facts that stay true, phrased as facts.** An entry is a declarative statement about the project — "tests run with pytest, single-threaded" — not an instruction to yourself — "always run tests single-threaded". Imperative phrasing gets re-read as a standing order by later sessions and can override what the user is actually asking for that day. And apply the week test before writing: if a line will be stale in a week — a PR number, a commit hash, "phase N done", a file count, today's task progress — it belongs in git or the decision log, not in memory.

**Some lessons must never harden into guidance.** Four kinds of "learning" rot into standing constraints that outlive their cause — don't record them as facts:

- An environment-dependent failure (a missing tool, a fresh-install error). The user can fix these; they are not durable rules.
- A negative claim about a tool ("X doesn't work", "Y is broken"). These harden into refusals the next session cites against itself long after the actual problem was fixed. Record the working alternative instead, or nothing.
- A transient error that resolved before the session ended.
- An approach that never actually worked, written up as if it were a reliable workflow. An unresolved failure recorded as guidance is the worst entry a memory can hold — the next session will trust it and repeat it.

A still-live blocker is worth noting — but as a dated open problem in `active-context.md`, where it gets struck when it resolves, never as a timeless fact in a topic note.

**Maintain it; don't let it pile up.** Before adding a note, check for one that already covers the topic and update that instead of making a second. Fix a note that's gone stale; delete one that turns out wrong. Keep each index line in sync with its note. A lean, current memory is worth far more than an exhaustive one.

**A work session is not a topic.** The default memory action at the end of a session is UPDATING the note for the topic you touched — the nav note absorbs the nav iteration, the relay note absorbs the relay fix. A new note (and its index line) is earned only by a genuinely new system, decision, or lesson — never by "what I built today"; that record belongs in the project's decision log or git history. When a new approach replaces an old one, fold the old note's surviving lesson into the replacement and delete the old file. Held to this, the index grows with the number of live systems — which plateaus — instead of growing with time, which is how a memory blows past its budget in weeks.

**`active-context.md` is written in one-liners.** It's always-loaded, so it has a *character* budget, not a line budget — one bullet holding a build-report paragraph weighs as much as ten short ones, and that's how the pair goes heavy days after a tidy while still "looking like a page." Each in-flight item is one line: what it is, a pointer (commit, note, or decision-log entry), and the single next action. The detail goes into the topic note or decision log *at the moment you write it* — deferring that to tidy time is the leak.

**Remove finished work the moment it lands.** active-context bloats because adding is prompted and removing isn't — a line goes in when work starts and only ever comes out at a tidy, so the file sawtooths up between purges. Close the loop yourself: when something you noted there ships, gets verified, or deploys, delete its line that same session — the same reflex as adding a changelog line at merge. Shipped work is recorded in git and the decision log; it does not also need to sit in active-context. Held to this, removal is continuous instead of a periodic purge, active-context stays a page on its own, and the heavy-memory warning rarely fires.

**Tidying a heavy memory.** The always-loaded pair has a real cost: past roughly a page of active-context plus a one-line-per-note index, it weighs down every turn of every session. When asked to tidy the memory (Koda's status bar warns the user when the pair crosses that line), work in this order:

1. **Distill `active-context.md` to a short current-state page** — current focus, next step, open questions. First strike every line whose work already shipped or verified — it's in git and the decision log, and active-context is not the record. Then move a long pending/in-flight list into its own on-demand note with a one-line pointer, and push session narratives, bring-up war stories, and build detail DOWN into the topic note they belong to (create it if missing). active-context keeps orientation plus pointers, nothing else.
2. **Archive the long tail of log-style notes** (decision logs, running trackers): move entries older than the current stretch of work to a dated file under the project's archive location and leave a pointer where they came from. Never silently drop a decision — archived is findable, deleted is gone.
3. **Collapse replaced notes into their survivors.** A note whose approach was replaced does NOT stay as a SUPERSEDED stub — chains of those are how the index outgrows its budget. Read the dead note, fold what still matters into the live note that replaced it (a one-line "tried X, rejected because Y", a gotcha that outlived the design), then delete the file and its index line. Deleting is safe: the note's history stays in the project's version history, and the lesson now lives where the next reader will actually look. Keep a SUPERSEDED marker only while the replacement isn't fully landed yet; delete outright what turned out to be wrong.
4. **Re-tighten the index**: every line still matches its note, hooks stay one line, the most load-bearing notes sit first. A good tidy leaves the index with FEWER lines, not just shorter ones — if every line survived, step 3 was skipped.

Report back in the user's terms: what got shorter, where the detail went, and that nothing was lost.

**This is your memory, not the user's.** It lives hidden under `.koda/` and is separate from their `Documents/`. The user generally won't read it — write it for yourself, next time.
