---
name: app-data
description: How to design and evolve a mini app's local data layer — the SQLite schema, migrations, and the DATA.md contract. Use when creating an app's first schema, adding or changing fields or tables, adding a new write path (form, import, agent turn), or when data failed to survive a restart.
---

# App data layer

The data is the app. Faces get rebuilt, slices get added, but the user's records must survive every one of those changes untouched. Design the data layer as the most durable thing in the project.

## One canonical store

Canonical app-owned data lives in one SQLite file inside the app's folder, declared in the manifest. No second store, no JSON files quietly accumulating alongside the database, no in-memory state that matters after a restart. If a value would upset the user by disappearing, it belongs in the database.

Choose the SQLite driver the way the mini-app recipe chooses any method: verify current options against primary documentation at build time rather than assuming a remembered favorite. Whatever the driver, enable foreign-key enforcement and use a write mode safe for an app that may be stopped at any moment.

## Design the schema for the data, not the UI

Model the real entities and their relationships, not the current screen. A tracker's schema outlives its first dashboard.

Every table gets, from the first version:

- a stable ID that never changes for the life of the record (the face may display names; the schema references IDs);
- created and updated timestamps;
- explicit ownership shape when the app can ever be shared — even owner-only apps name the owner rather than assuming it.

Prefer real columns with types over a JSON blob column. A blob is where queries, charts, and migrations go to die; reach for one only for genuinely free-form payloads, never for fields the app filters, sums, or sorts on. Use restrictive types and constraints (NOT NULL, UNIQUE, CHECK) so bad writes fail at the database instead of surfacing as a corrupt chart weeks later.

Store canonical facts; derive views. Totals, streaks, and chart series are queries over the records, never columns that must be kept in sync.

## Migrations from day one

The first schema is migration 001. All schema changes after it are new, ordered migration files in `schema/` — never an edit to a migration that has already run, and never a hand-typed ALTER in a shell.

- The app applies pending migrations at startup and records which have run, so any copy of the database can be brought current.
- Before a destructive migration (dropping or rewriting columns, transforming data), copy the database file aside, run the migration against the copy first, and verify the data came through. Lead with restoring that copy if it goes wrong.
- A migration that transforms data states its intent in a comment: what moves where, and what is deliberately discarded.

## DATA.md is the contract

`DATA.md` sits next to `schema/` and explains the data in plain terms: the entities, their fields and meaning, how they relate, who owns what, and what each write path is allowed to do. It is written for the next agent session that touches this app — the one that must add a field without re-deriving the design from raw SQL.

Keep it in lockstep: a migration that changes shape updates DATA.md in the same step. Project memory may point to it, but never replaces it.

## Every write path honors the same contract

Forms, imports, agent data turns, and any future sync all write through the same schema with the same validation. No path gets to invent its own shape.

The hard rule: never parse free-form agent prose to feed durable records or charts. When an agent turn should produce data, the turn writes structured records through the contract; if it can only produce prose, that prose is not data.

Reject bad input at the boundary in the user's terms ("that date is in the future") rather than storing it and sanitizing later.

## Prove durability

A slice's data layer is not done until the lived test passes: create real records through each write path in the slice, restart the app, and confirm every record is still there and the views rebuilt from it are correct. Run it again after any migration.
