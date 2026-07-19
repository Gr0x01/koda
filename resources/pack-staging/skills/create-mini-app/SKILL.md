---
name: create-mini-app
description: Turn a Koda project into a durable, view-first mini app that Koda can make and run. Use when creating, extending, or repairing a personal app with a persistent face, local data, Koda-managed lifecycle, or an in-app line to its agent—for requests such as “make me a fitness tracker,” “turn this project into an app,” or “add a dashboard to this app.”
---

# Create a Koda mini app

Build a project that grew a face, not a generated artifact that leaves its workshop behind. The app must remain useful as a normal project without Koda-specific lifecycle metadata.

## Shape before you build

A new-app request is a shaping request, not a build order. Your first response is questions and a short plan — never a finished-looking app. The failure mode this skill exists to prevent: reading one prompt as full license, scaffolding every tab and feature at once, and handing back a shell where half the controls do nothing. Do not do that.

Before you write any code:

1. Ask only the two or three user-facing questions that materially change what gets built. Do not ask about architecture or libraries.
2. Name the single daily-use loop worth building first, and say plainly what you are leaving for a later slice. Hold the full vision; build one slice of it.
   The first slice must put the user's stated goal on screen. If they asked "when can we retire?", slice 1 shows a first rough answer to that question — built from a few numbers they can tell you in a sentence — not a pipeline that will feed the answer three slices from now. Import, ingestion, and other plumbing are supporting slices, never the lead: a first slice whose main activity is the user feeding in data reads as "you're doing my data entry, not building my app." If a data foundation genuinely must come first, present that ordering in the plan as a trade-off the user chooses knowingly, not an order they discover after the build.
3. Lay out a short plan in the user's terms and get a go before writing any code: the one slice you'll build, the view it opens on and the few daily actions, what it stores, and the look direction. Keep it plain — what they'll see and do, not an engineering spec. Write it as a **checklist document the user can open** — `Documents/Build plan.md` in the app project, one checkbox per piece in their terms, the slice you're proposing on top and the deferred slices listed below it — and ask for the go against that document. The plan is a shared artifact, not something you hold in your head: going back and forth on what gets built means editing that doc together, and the user should be able to pull it up at any moment and see what's built, what's in progress, and what's still to come.
4. Only after they approve, build that one slice, make it genuinely work and look deliberate, then offer the next slice.
5. When you report the finished slice, check off its items in the plan document, then place it against the plan in their terms: name their goal, say which slice this was and what it just did for that goal, and what comes next. A slice delivered without its place in the plan reads as the wrong app — even a good one.

The plan document is the shared source of truth for what's being built. Keep it current as a reflex, not a tidy step: check items off as they land, add slices as they're agreed, and record it when the user redirects. The app project's own project memory (`.koda/memory/`) holds the agent-side state — a pointer to the plan doc, the shaping facts and decisions, which slice is in progress — so a build spread across turns or sessions, including Koda's "fix this app" turn, resumes from the plan instead of re-guessing the shape. Memory is for you; the plan doc is for both of you — never let the two disagree about what's done.

Identify while shaping:

- the view the app opens on;
- the few actions used every day;
- whether it must work on the phone while the Mac is asleep;
- whether it is owner-only, shared with known people, or intended for independent users;
- which inputs are forms, interactive agent turns, or unattended automation.

If phone-with-Mac-asleep is part of the primary loop and Koda's current phone face/data contract is absent, stop at that platform boundary and explain the missing capability. Do not quietly ship a Mac-dependent version or invent a generated Node runtime for iOS.

When the user wants AI in the app, present the billing reality as part of shaping, in their terms, before building anything:

- **Their subscription** powers interactive turns at no extra cost: they ask, the agent does — in Koda or through the running app's built-in ask-or-fix line. The limits: it only runs when they ask (nothing scheduled, nothing automatic, nothing while they sleep), and turns share their subscription's usage limits.
- **Their own API key** is what unattended AI would bill against — scheduled summaries, auto-processing on save, background categorization — set up deliberately per app and costing real money per run.

Recommend the subscription route unless the daily loop genuinely needs unattended runs, and never present the two as interchangeable. Never wire automation to the subscription.

## Verify methods, preserve invariants

Treat this skill's product rules as invariants. Verify time-sensitive implementation methods—current library versions, APIs, and recommended patterns—against primary documentation before choosing them. Present the recommendation and reason in the user's terms, then proceed; do not dump options or follow stale examples blindly.

Prefer the standard Koda mini-app stack and dependencies already common in Koda mini apps. Adding an unfamiliar package, runtime, hosted service, or user account requires the user's approval. Never add Docker or a system service for a personal local app.

## Create the app boundary

Place each app in `apps/<slug>/`. Keep app code, app-owned assets, its SQLite database, schema, and migrations inside that folder. Declare every mutable data path—including the app-owned SQLite file—and every shared project path with its access mode in the manifest. Derived deployment, phone, and sharing bundles must exclude declared data by default.

Use the current lifecycle capability's manifest schema. A managed faced project declares, at minimum, its name, icon, entry point, and data access in `koda-app.json`. Treat that file as optional Koda integration: deleting it may remove Koda installation behavior, but must not make the underlying app impossible to build, run, or deploy normally.

Keep the runtime contract narrow:

1. Read the assigned port from the host environment; never hardcode it.
2. Bind only to loopback or the Koda-supplied transport.
3. Use only declared project paths. In raw-process v1 this is a portability and correctness contract, not an OS security boundary.
4. Accept viewer identity from the host. Do not build a login screen or credential store for an owner-managed app.
5. Accept only narrowly injected secrets; never copy provider credentials into the app.

Use directory-scoped dependencies. Do not assume globally installed packages, runtimes, databases, or services.

## Make data durable

Before creating or changing the schema, a migration, or a write path, read the `app-data` skill and follow it — it owns the craft of the data layer; this section states the product rules.

Use SQLite for canonical app-owned data. Create stable record IDs, timestamps, explicit ownership shape, and versioned migrations from the first schema.

Keep the canonical data contract with the app:

- `DATA.md` explains entities, fields, relationships, ownership, and durable write semantics.
- `schema/` contains the schema and ordered migrations.
- Project memory contains only a pointer and current operating guidance, never the sole schema contract.

Every structured write path—form, bridge turn, import, or sync—must honor the same contract. Do not parse free-form agent prose to feed charts or other durable views.

## Assemble the face

Open on the useful view, never a composer or Koda Preview. A faced project's existing launcher tile becomes the app's icon and name; do not create a second Apps section or launcher.

Before designing or restyling the face, read the `frontend-design` skill and follow its process — it owns the design craft (direction, typography, the plan-then-critique loop); this section states the product rules, and where they conflict this section wins.

Build the face with shadcn/ui on the standard static-frontend stack: copy components into the app (app-owned source, never a shared runtime package) and theme them through design tokens. Verify shadcn's current setup and component patterns fresh at build time like any other method. If the app's stack cannot host shadcn, choose a neutral equivalent the same way: copy-in source, token-themed.

Design direction is a shaping question, not a default — each app gets its own look, steered by its owner. When the owner has expressed no preference, offer two or three concrete named directions to react to (quick HTML mocks work well); only an explicit "you pick" lets you choose, and then choose distinctively and say what you chose. Never ship shadcn's untouched stock look (slate or zinc neutrals, Inter, muted indigo).

Quality floor for every face, whatever its look:

- Make at least three deliberate visual choices: a non-default palette or neutral, a typeface that is not Inter or a system default, and one repeated layout primitive.
- Banned tells: emoji standing in for icons or status glyphs (use a real icon set), lavender or indigo default accents, permanent dark with glowing borders, gradient orbs, badge-over-headline heroes, rows of identical icon-topped cards, colored card top-borders, all-caps label grids.
- Every control shown must do something. Do not render a button, field, tab, or paste-box for anything this slice has not wired — if it is not built, it does not appear. A control that silently does nothing is the worst tell of a one-shot shell.
- Support light and dark appearance, use real data-bound charts over decorative ones, keep controls accessible, and bind everything to the app's SQLite data contract.

Optimize for viewing first; input is secondary. Use plain controls for structured input instead of forcing inference.

## Keep the workshop attached

Route AI through Koda's host bridge. The app must never store provider credentials or call a subscription-backed engine directly.

The in-app bridge is not yet available. Today the app's AI is the agent itself: the user sends turns in Koda or through the running app's built-in ask-or-fix line, and results land in the app's data contract. Do not invent an in-app AI endpoint, embed a provider SDK or API key in the app, or promise in-app AI the platform cannot host yet — that is a platform boundary to state plainly. Unattended inference is likewise not yet available: when the core loop needs it, say so and design the manual-turn version today.

- Interactive, user-initiated turns may use the user's Koda subscription.
- Unattended or scheduled inference requires explicit API billing configured for that app.
- Clock-based reminders without inference are allowed.
- Owner bridge access may include data and build turns.
- A collaborator gets a personal bridge only after explicit authorization and with their own connected provider.
- An ordinary end user never receives an implicit agent session.

Design agent affordances into the app where they help, but do not impose one universal composer. Include enough bridge context to identify the app, active view, and manifest. Rely on Koda's host-level “fix this app” action as the guaranteed build-turn escape hatch.

Treat the summon as one durable logical thread backed by project files and data, not a permanently warm engine process. Never recycle it during an exchange.

## Use Koda lifecycle and recovery

Install, start, stop, and inspect the app only through Koda's lifecycle capability. Do not hand-roll background process management in shell commands, add a daemon, or ask the user to start a server.

Checkpoint before build turns. Let the supervisor own ports, process termination, bounded restart/backoff, reload, and crash-loop detection. If a build turn breaks the app, lead with restoring the known-good checkpoint.

## Verify the lived loop

Prove the smallest daily-use loop end to end:

1. Install and start through Koda.
2. Open the project and confirm it lands on the face.
3. Create or change real data through each input mode included in the slice.
4. Restart the app and confirm the data survives.
5. Send one data turn and confirm the view refreshes.
6. Send one build turn and confirm the face safely reloads.
7. Stop and inspect status through Koda.

Exercise phone, offline, sharing, or automation behavior whenever the promised slice includes it. Do not call the app complete if its primary context is unverified.

## Keep graduation reversible

Do not add app-level authentication, Supabase, cloud hosting, or public sharing to an owner-managed personal app. When the user deliberately graduates the app to independent users, explain that the new service belongs to them—their account, bill, users, and data—and migrate through a verified path with rollback. Sharing third-party app code requires a real sandbox and is outside the trusted owner-created v1 runtime.
