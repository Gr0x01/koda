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

- Something the next session must **act on** — a handoff, an open problem to pick up, an approach you just reverted so nobody rebuilds it — goes in `active-context.md`. That's the one note guaranteed to be read.
- A topic fact (how a subsystem works, a decision, a gotcha) belongs in its own note — but it's invisible until an index line leads there. So writing the note isn't done until its `MEMORY.md` line exists and its hook tells the reader why they'd open it. Detail in a note + a pointer in `active-context.md` or the index is the pattern; detail in a note *alone* is a fact nobody will find.

**When to write a note.** Capture what should outlast the session: how a part of the project works, a decision and *why*, a constraint, a gotcha you hit and how you got past it. Skip transient task state, and skip anything already obvious from the code or git history — memory is for what you can't re-derive by looking.

**Maintain it; don't let it pile up.** Before adding a note, check for one that already covers the topic and update that instead of making a second. Fix a note that's gone stale; delete one that turns out wrong. Keep each index line in sync with its note. A lean, current memory is worth far more than an exhaustive one.

**Tidying a heavy memory.** The always-loaded pair has a real cost: past roughly a page of active-context plus a one-line-per-note index, it weighs down every turn of every session. When asked to tidy the memory (Koda's status bar warns the user when the pair crosses that line), work in this order:

1. **Distill `active-context.md` to a short current-state page** — what's in flight, next steps, open questions. Session narratives, bring-up war stories, and build detail move DOWN into the topic note they belong to (create the note if it's missing); active-context keeps a one-line pointer at most.
2. **Archive the long tail of log-style notes** (decision logs, running trackers): move entries older than the current stretch of work to a dated file under the project's archive location and leave a pointer where they came from. Never silently drop a decision — archived is findable, deleted is gone.
3. **Supersede, don't delete.** A note whose approach was replaced gets marked SUPERSEDED with a `[[link]]` to what replaced it. Only delete what is outright wrong.
4. **Re-tighten the index**: every line still matches its note, hooks stay one line, the most load-bearing notes sit first.

Report back in the user's terms: what got shorter, where the detail went, and that nothing was lost.

**This is your memory, not the user's.** It lives hidden under `.koda/` and is separate from their `Documents/`. The user generally won't read it — write it for yourself, next time.
