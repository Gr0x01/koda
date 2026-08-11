---
name: create-mini-app
description: Turn a Koda project into a durable, view-first mini app that Koda can make and run. Use when creating, extending, or repairing a personal app with a persistent face, local data, Koda-managed lifecycle, or an in-app line to its agent—for requests such as “make me a fitness tracker,” “turn this project into an app,” or “add a dashboard to this app.”
---

# Create a Koda mini app

Build a project that grew a face, not a generated artifact that leaves its workshop behind. The app must remain useful as a normal project without Koda-specific lifecycle metadata.

## Shape before you build

A new-app request is a shaping request, not a build order. Your first response is questions and a short plan — never a finished-looking app. The failure mode this skill exists to prevent: reading one prompt as full license, scaffolding every tab and feature at once, and handing back a shell where half the controls do nothing. Do not do that.

The opposite case never shapes: a message marked "Sent from the app's ask-or-fix line" is the user OPERATING an app that already exists — record the data, answer the question, or make the fix, and reply in a sentence or two. Shaping, plans, and this section's questions are for making an app, never for using one.

Before you write any code:

1. Ask only the two or three user-facing questions that materially change what gets built. Do not ask about architecture or libraries.
2. Name the single daily-use loop worth building first, and say plainly what you are leaving for a later slice. Hold the full vision; build one slice of it.
   The first slice must put the user's stated goal on screen. If they asked "when can we retire?", slice 1 shows a first rough answer to that question — built from a few numbers they can tell you in a sentence — not a pipeline that will feed the answer three slices from now. Import, ingestion, and other plumbing are supporting slices, never the lead: a first slice whose main activity is the user feeding in data reads as "you're doing my data entry, not building my app." If a data foundation genuinely must come first, present that ordering in the plan as a trade-off the user chooses knowingly, not an order they discover after the build.
3. Lay out a short plan in the user's terms and get a go before writing any code: the one slice you'll build, the view it opens on and the few daily actions, what it stores, and the look direction. Keep it plain — what they'll see and do, not an engineering spec. Write it as a **living document the user can open** — `Documents/Build plan.md` in the app project — with a standing shape, not a flat checklist: it opens with a **What your app does today** section (a plain-language running list of what the app actually does, empty at first), then **The bar** (below), then **Building now** (the current slice), then **Planned** (the deferred slices, one checkbox each in their terms). Ask for the go against that document. The doc is a shared artifact, not something you hold in your head: going back and forth on what gets built means editing it together, and the user should be able to pull it up at any moment and see, in one place, what their app does now, what's being built, and what's still to come.
4. Set the bar, in that same document, before any code exists. **The bar is yours to write, not the user's to supply** — you know this category of app and what a good one feels like; making them name a reference is friction for nothing. Write four or five statements a stranger could check by using the running app, concrete enough to fail: "opens straight to today's numbers, no tap"; "logging a meal is under three seconds and two taps"; "reads like something they'd pay for, not an admin dashboard". A named app they'd admire is a fine shorthand when one genuinely fits ("as quick to log in as Things is to add a task"), but the written statements are the bar, not the name. Let the user react to it as part of the go — they will sharpen it, and that agreement is what makes it binding later.
   Write it *while shaping*, and then leave it alone. A bar you set after building is a bar you have already cleared: it will describe the thing you happened to make, which is the whole failure this exists to prevent. Adjust it when the app's ambition genuinely changes, in conversation with the user, never while a slice is being judged against it.
5. Only after they approve, build that one slice, make it genuinely work and look deliberate, then offer the next slice.
6. When you report the finished slice, update the document by **moving, not marking**: add what the slice now lets the user do to the **What your app does today** section in plain terms, and *remove* that slice's items from **Building now**/**Planned** — its work now lives once, as a capability line up top, never as a ticked-off box left behind. Only the feature list grows; the plan stays a short queue of what's active and next. This is what keeps the doc from ballooning: it tracks the app's current capabilities plus a small forward plan, not a running history of checkboxes (that history lives in project memory and the decision log, not the user's doc). Then place it against the plan in their terms: name their goal, say which slice this was and what it just did for that goal, and what comes next. A slice delivered without its place in the plan reads as the wrong app — even a good one. The slice that first registers the app is also its graduation moment — say where the app now lives (on the Mac: its tile on the app rail at Koda's home; on their phone: the "Your apps" shelf on Home), or the user never learns a launcher tile appeared.

This document is the shared source of truth for what the app is and what's being built. Keep it current as a reflex, not a tidy step: grow the "what it does today" list as slices land, keep the plan a short working queue (promote shipped slices up into the feature list and clear them out — don't let ticked boxes pile up), add new slices as they're agreed, and record it when the user redirects. The app project's own project memory (`.koda/memory/`) holds the agent-side state — a pointer to the plan doc, the shaping facts and decisions, which slice is in progress — so a build spread across turns or sessions, including Koda's "fix this app" turn, resumes from the plan instead of re-guessing the shape. Memory is for you; the plan doc is for both of you — never let the two disagree about what's done.

Identify while shaping:

- whether this is a personal app Koda runs — the form this skill builds — or something meant to be published for the world (a public website, a hosted service others visit). Present the choice in their terms when it isn't obvious: a Koda app lives on their Mac and phone with no accounts or hosting; a published site lives on the open web. If they want the published thing, say so plainly and build it as a normal project without this skill's lifecycle — don't force a manifest and face onto something whose home is elsewhere;
- the view the app opens on;
- the few actions used every day;
- whether it must work on the phone while the Mac is asleep;
- whether it is owner-only, shared with known people, or intended for independent users;
- which inputs are forms, interactive agent turns, or unattended automation.

If phone-with-Mac-asleep is part of the primary loop and Koda's current phone face/data contract is absent, stop at that platform boundary and explain the missing capability. Do not quietly ship a Mac-dependent version or invent a generated Node runtime for iOS.

The same rule applies when the app is for someone besides the owner: Koda cannot yet put an app's face on another person's phone (pairing today links only the owner's own phone, to the whole agent). Say that boundary plainly in the user's terms before offering any outside route — never silently pivot to generic hosting options as if the Koda-native path didn't exist.

When the user wants AI in the app, present the billing reality as part of shaping, in their terms, before building anything:

- **Their subscription** powers interactive turns at no extra cost: they ask, the agent does — in Koda or through the running app's built-in ask-or-fix line. The limits: it only runs when they ask (nothing scheduled, nothing automatic, nothing while they sleep), and turns share their subscription's usage limits.
- **Their own API key** bills everything the app fires itself, with no agent in the loop: AI designed into the app's own screens (a categorize-this button, describe-a-photo) and unattended runs (scheduled summaries, auto-processing on save). It costs real money per call, is allowed per app by an explicit Settings toggle (off by default), and an unattended piece must be named as such in the plan — "this part runs on its own → your API key, cents a run" — never discovered on a bill.

Recommend the subscription route unless a feature genuinely needs to fire without the user asking the agent, and never present the two as interchangeable. Never wire automation to the subscription.

## Verify methods, preserve invariants

Treat this skill's product rules as invariants. Verify time-sensitive implementation methods—current library versions, APIs, and recommended patterns—against primary documentation before choosing them. Present the recommendation and reason in the user's terms, then proceed; do not dump options or follow stale examples blindly.

Prefer the standard Koda mini-app stack and dependencies already common in Koda mini apps. Adding an unfamiliar package, runtime, hosted service, or user account requires the user's approval. Never add Docker or a system service for a personal local app.

## Create the app boundary

Place each app in `apps/<slug>/`. Keep app code, app-owned assets, its SQLite database, schema, and migrations inside that folder. Declare every mutable data path—including the app-owned SQLite file—and every shared project path with its access mode in the manifest. Derived deployment, phone, and sharing bundles must exclude declared data by default.

Use the current lifecycle capability's manifest schema. A managed faced project declares, at minimum, its name, icon, launch command, and data access in `koda-app.json`. The `entry` value is the **complete shell command Koda runs** (for example, `"entry": "node server.mjs"`) — never split it into an `entry` filename plus a `start` field. Treat that file as optional Koda integration: deleting it may remove Koda installation behavior, but must not make the underlying app impossible to build, run, or deploy normally.

Also declare the app's design tokens in the manifest's optional `theme` object — `{ "theme": { "accent": "...", "surface": "...", "text": "...", "border": "...", "font": "..." } }`, CSS color values (and a font-family string) drawn from the app's own design system, any subset. Koda's overlay chrome on the face — the ask-or-fix pill, the agent's reply, inline question chips — wears these tokens, so its floating pieces read as part of the app instead of foreign chrome. Update the theme when the app's look changes.

The icon is a real asset you create, not a placeholder: design a simple flat mark for the app (one glyph or shape on a solid or subtly toned square ground — no emoji, no text-heavy art), save it inside the app folder as a square SVG or PNG (256px or larger), and point the manifest's `icon` at it. It is the app's identity on the Mac launcher rail and the phone springboard; without one the tile falls back to a lettered monogram.

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

If the app must work on the phone while the Mac is asleep, the data layer must also satisfy the offline data contract in `references/phone-face.md`: reads and writes expressed as declared SQL over the schema (so the phone can answer them from its replica with no Node), client-generated stable ids with idempotent writes, tombstone deletes, and a per-row change sequence with a `GET /api/_changes?since=` endpoint. Build it in from the first schema; it cannot be retrofitted without a rewrite. Do not hand-write the Mac server's `/api` handlers for such an app: declare the routes in `sync/queries.json` and copy `references/app-data-engine.mjs` verbatim into the app's `lib/` — that file IS the engine, and the phone runs the same contract, so the two can't drift. The app's `server.mjs` opens the `node:sqlite` database and static-serves the face; for every `/api` request it hands `{ method, path, query, body }` to `createEngine({ db, queries }).handle(...)` and returns the `{ status, body }`. The engine owns reads, writes, `change_seq`, and `_changes`; server.mjs owns only the HTTP glue.

## Assemble the face

Open on the useful view, never a composer or Koda Preview. A faced project's existing launcher tile becomes the app's icon and name; do not create a second Apps section or launcher.

Before designing or restyling the face, read the `frontend-design` skill and follow its process — it owns the design craft (direction, typography, the plan-then-critique loop); this section states the product rules, and where they conflict this section wins.

Build the face with shadcn/ui on the standard static-frontend stack: copy components into the app (app-owned source, never a shared runtime package) and theme them through design tokens. Verify shadcn's current setup and component patterns fresh at build time like any other method. If the app's stack cannot host shadcn, choose a neutral equivalent the same way: copy-in source, token-themed. shadcn is a parts bin, not a layout: pick the touch-native pieces and translate the pointer-era ones — `references/phone-face.md` § iPhone idiom owns the specifics.

Design direction is a shaping question, not a default — each app gets its own look, steered by its owner. When the owner has expressed no preference, offer two or three concrete named directions to react to (quick HTML mocks work well); only an explicit "you pick" lets you choose, and then choose distinctively and say what you chose. Never ship shadcn's untouched stock look (slate or zinc neutrals, Inter, muted indigo).

Quality floor for every face, whatever its look:

- Make at least three deliberate visual choices: a non-default palette or neutral, a typeface that is not Inter or a system default, and one repeated layout primitive.
- Banned tells: emoji standing in for icons or status glyphs (use a real icon set), lavender or indigo default accents, permanent dark with glowing borders, gradient orbs, badge-over-headline heroes, rows of identical icon-topped cards, colored card top-borders, all-caps label grids.
- Every control shown must do something. Do not render a button, field, tab, or paste-box for anything this slice has not wired — if it is not built, it does not appear. A control that silently does nothing is the worst tell of a one-shot shell.
- Support light and dark appearance, use real data-bound charts over decorative ones, keep controls accessible, and bind everything to the app's SQLite data contract.
- Every tap responds instantly. The face is often viewed from a phone whose route to the server crosses the internet, so the network never sits between an interaction and its visible result: update the UI optimistically the moment the user acts, send the write in the background, and reconcile on the response — rolling back with a brief notice only if the write actually failed. `setState(await api(...))` on a tap handler is a banned pattern; it feels fine on the Mac and laggy everywhere else.
- The face moves like an app, not a document. State changes animate: a logged item settles into its list instead of popping in, a sheet slides up and away, a switched view transitions, a number that changed draws the eye to the change. Interface motion is feedback for something the user did — short (roughly 150–300ms), eased or spring-like, never ambient decoration — and it degrades to fades under Reduce Motion. Zero motion is as loud a tell as emoji icons: it is the difference between a working app and one that feels finished. (The `frontend-design` skill's caution about animation is about decorative page effects; it does not license a static interface.)

The face is a phone face by default, not a desktop page that happens to shrink. Every registered app lands on the owner's iPhone (the "Your apps" shelf on Home) as well as the Mac's app rail, and the phone is where a personal app earns its daily use — so assume the face will be lived in on an iPhone unless the user explicitly scopes the app to the Mac alone. Read `references/phone-face.md` **before designing any face** and follow it; it owns the iPhone rules: chrome and safe-area insets, the summon-corner reservation, touch idiom and component choice, keeping the served payload lean, and the offline data contract an app must satisfy to keep working while the Mac is asleep. Three of its pieces are copy-verbatim files, not code to hand-write — `references/koda-face.js` (the viewport runtime that keeps content clear of the Dynamic Island, home indicator, and keyboard) always, `references/face-kit/` (the five interaction primitives — `AppShell`, `Sheet`, `Field`, `Pressable`, `pick()` — that own the face's physics: safe-area frame, sheet spring and drag-to-dismiss, the keyboard contract, tap states, native attach) always, and `references/app-data-engine.mjs` when the app works offline. Copy them in and include/require them exactly like a dependency; do not retype any of them from prose. Appearance stays yours (shadcn + the design direction from shaping, skinned through the kit's className props); feel is the kit's — build every screen inside `AppShell`, every chooser as a `Sheet`, every input as a `Field`, every button as a `Pressable`, every attach through `pick()`.

Optimize for viewing first; input is secondary. Use plain controls for structured input instead of forcing inference.

## Keep the workshop attached

Route AI through Koda's host bridge. The app must never store provider credentials or call a subscription-backed engine directly.

The app's AI has two lanes. Interactive turns run against this project's agent — the user sends them in Koda, through Koda's summon, or through the app's own agent line over the face bridge (below) — and results land in the app's data contract. Plain inference the app fires itself (a model call designed into its own UX, no agent in the loop) goes through the host's inference endpoint, billed to the owner's API key: the supervisor hands the app `KODA_BRIDGE_URL` and `KODA_BRIDGE_TOKEN` in env at start — read both at every start, the token rotates. POST `KODA_BRIDGE_URL/v1/infer` with header `Authorization: Bearer <KODA_BRIDGE_TOKEN>` and JSON `{ prompt, system?, tier?, maxTokens? }`; the reply is `{ text, model, usage }`. Ask for a **tier** — `'fast'` (the default, cheap and quick) or `'smart'` (harder judgment) — never a model id; the host maps tiers to current models so apps don't rot. The endpoint refuses until the owner has allowed this app in Settings → AI providers → Anthropic (off by default, and it needs a connected API key): handle a 402 or 403 by saying that state plainly in the UI with where to turn it on — never hide the feature or fail silently. Never embed a provider SDK or API key in the app, and never call a provider directly.

- Interactive, owner-initiated turns may use the owner's Koda subscription. A subscription is one person's account: turns initiated by anyone else — a family viewer, a collaborator, an end user — never ride it, no matter how interactive.
- Unattended or scheduled inference requires explicit API billing configured for that app.
- Clock-based reminders without inference are allowed.
- Owner bridge access may include data and build turns.
- A collaborator gets a personal bridge only after explicit authorization and with their own connected provider.
- An ordinary end user never receives an implicit agent session.

Design agent affordances into the app where they help, but do not impose one universal composer. The app can host its **own** agent line — folded into its primary action or placed inline — through the face bridge, instead of wearing Koda's floating summon. Wire it with this handshake, and render your own line only after the host confirms the bridge, so the same app degrades gracefully to Koda's summon on a surface that lacks it (never a dead agent control):

- On load, post `{ type: 'koda:ready' }` to `window.parent` with targetOrigin `'*'` (you can't know Koda's origin, and you send only intents, never secrets). If the host supports the bridge it replies `{ type: 'koda:host', agentBridge: true }`. Only render your own agent line once you receive that. Post every later message to the parent the same way. The reply also names any native powers that surface lends the face (`viewport: true`, `haptics: true` on the phone — measured keyboard/safe-area geometry and haptic taps); treat each as absent unless announced, and see `references/phone-face.md` § Native powers over the bridge for how to use them.
- To take the line over so Koda hides its summon, post `{ type: 'koda:claim-agent-line' }`.
- To run a turn, post `{ type: 'koda:ask', text }`. The host runs it against this project's agent, grounded in this app automatically, and replies `{ type: 'koda:ask-result', dispatched }` — `dispatched: false` means the agent was mid-turn, so keep the user's text and let them retry.
- When the turn lands, a host that supports it posts `{ type: 'koda:reply', text }` — the agent's closing message (a sentence or two: the confirmation, the answer, any assumption it made). A landed turn also reloads the face, so the reply arrives in the RELOADED document, shortly after your `koda:ready`/`koda:host` exchange — handle it in the same message listener you register on load, not one tied to pre-reload state. Show it in the app's own voice near your agent line; treat the message as absent on hosts that never send it. An app wearing Koda's summon needs none of this — Koda shows the same reply itself, so never build a duplicate confirmation toast for agent turns.
- The host pushes `{ type: 'koda:status', state: 'working' | 'needs-user' | 'idle' }` so your line can shimmer while a turn runs. On `needs-user` the turn is blocked on an approval only Koda can resolve; point the user to Koda rather than trying to answer it in the app.
- Only accept host messages from `window.parent`, and post yours to the parent. Never embed a provider key — the bridge runs the turn on Koda's side, so the app never holds credentials.

Koda always keeps a recessive escape hatch (the workshop, and an approval prompt when a turn blocks), so an app that owns — or even removes — its agent line can never lock the user out of the agent.

Treat the summon as one durable logical thread backed by project files and data, not a permanently warm engine process. Never recycle it during an exchange.

When you register the app, also write this host contract down where the next session will find it: a short `koda-host.md` note in the app project's `.koda/memory/` (with an index line in `MEMORY.md`) recording where Koda floats its summon over the face — a bottom-center pill on the Mac face, a bottom-right spark on the phone; a face layout must keep clear of both — that the app can claim the agent line over the face bridge instead (name the handshake messages, or point here), and whether this app currently wears the summon or hosts its own line. Future sessions — a layout fix, "why is this pill covering my button" — won't have this skill in context; without the note they re-derive the pill as immovable Koda chrome and design around it wrongly. Keep the note current when the app switches between the summon and its own line.

## Use Koda lifecycle and recovery

Install, start, stop, and inspect the app only through Koda's lifecycle capability. Do not hand-roll background process management in shell commands, add a daemon, or ask the user to start a server.

Preview is a build workbench, never the user's way into a graduated app. Registration is not graduation by itself: after creating the manifest, start the app through Koda and prove the launcher-served face loads before announcing its tile or telling the user where the app lives. If lifecycle start fails, the app has not graduated — fix the manifest, dependencies, or app code and retry through Koda. Never offer Preview as a temporary way to use it, create an app-local runtime shim, or modify system runtime paths; request Koda's runtime capability when the declared launch command needs a runtime that is absent.

Checkpoint before build turns. Let the supervisor own ports, process termination, bounded restart/backoff, reload, and crash-loop detection. If a build turn breaks the app, lead with restoring the known-good checkpoint.

Checkpoints are a safety net, not a backup: they are local, they thin out over time, and they exist to undo a bad turn — not to keep the app safe forever. Once a slice ships and the app holds real work the user would hate to lose, offer to save a permanent snapshot to the app's own git — in their terms ("a permanent save point you can always come back to"), distinct from Koda's automatic undo. If the project has no user git yet, offer to start one and make the first commit; at graduation, fold this into the same moment you tell the user their app got a launcher tile. Commit real milestones as slices land, and phrase it as an offer, not a nag — once per meaningful milestone, never every turn. This is the user's own git (skillful, milestone commits), never the invisible safety store.

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

## Put the slice through a critique pass

Working is not the same as good. Your guardrails already require a fresh critic on finished work the user will judge — that rule owns the shape of the pass (no build context, one biggest gap, a new critic on the re-check, two rounds, skip when there is no bar). Follow it here once the lived loop passes and before you report the slice as done. What a face adds:

- **The bar is the one in `Documents/Build plan.md`**, handed to the critic verbatim, along with this skill's banned tells and the every-control-does-something rule.
- **The critic opens the running app, never the source** — through Koda's lifecycle, on the face, and at a phone-width viewport when the app's home is the phone. It screenshots and actually uses the thing. A face's real gaps are the kind you only see by looking.
- **When you report the slice, say in one plain line what the pass changed** ("the critic said the day's total was buried under the log form, so it moved to the top"), or say it passed first time. Never report a slice as done with its critic's biggest gap still open.

A slice with nothing to look at yet — a migration, a data-only foundation — has nothing to critique, so the lived-loop proof is the whole check.

## Keep graduation reversible

Do not add app-level authentication, Supabase, cloud hosting, or public sharing to an owner-managed personal app. When the user deliberately graduates the app to independent users, explain that the new service belongs to them—their account, bill, users, and data—and migrate through a verified path with rollback. Sharing third-party app code requires a real sandbox and is outside the trusted owner-created v1 runtime.
