# The face on the phone

Read this before designing any face. Every registered app lands on the owner's iPhone (the "Your apps" shelf) as well as the Mac, and the phone is usually where the app gets lived in — so the face is an iPhone face first, whether served live from the Mac or offline while it sleeps. This file states the platform rules the recipe cares about; the main skill still owns shaping, data, and design.

Two facts drive everything here:

- The phone renders the app's face, but **the phone never runs the app's Node server.** On the Mac the face is served by the app's own process; on the phone the platform serves the same static bundle and answers the app's `/api/*` calls itself. So the face code is identical, but on the phone there is no Node behind `/api` — only what you designed the data layer to make answerable without it.
- **The Mac is the one authority.** The phone holds a copy (a replica) and a queue of the changes it made offline. When they reconnect, the phone's queued changes replay through the app's real write path on the Mac, and the phone pulls back whatever changed. There is no peer-to-peer merge and no second source of truth.

## When an app must work offline on the phone

Confirm this during shaping (the main skill asks "must it work on the phone while the Mac is asleep?"). A gym tracker used at the gym is the canonical yes: the user logs sets with no signal and the Mac at home asleep, and expects today's list and totals to update as they log. If the answer is no, the app only needs the live-served face (below) and you can skip the data-layer rules in this section.

If the answer is yes, the app's data layer must satisfy the offline data contract. Build it in from the first schema — retrofitting it into a live app is a rewrite.

### The offline data contract

The platform can answer the app's `/api/*` on the phone only because the data layer is structured so the same read and write logic runs against a plain SQLite copy, with no Node. That structure is the contract:

1. **Describe data access once, in `sync/queries.json` — one engine runs it on both sides.** The app does not hand-write `/api` server code. It declares its reads and writes in one file, and a small generic engine — the *same* engine on the Mac server and in the phone's offline layer — serves `/api` from it. That is what makes offline behavior provably identical to online: there is one description, not two implementations that can drift. The shape:

   ```json
   {
     "reads": {
       "GET /api/sets":        "SELECT * FROM sets WHERE deleted=0 ORDER BY at DESC",
       "GET /api/sets/:date":  "SELECT * FROM sets WHERE date=:date AND deleted=0"
     },
     "writes": {
       "POST /api/sets":       { "table": "sets" },
       "DELETE /api/sets/:id": { "table": "sets", "op": "delete" }
     }
   }
   ```

   - A **read** is the declared SQL for that route; path params (`:date`) and query-string params bind by name. A view that can only be computed as Node logic over the database can't be answered offline — express it as SQL, or accept that it's an online-only screen and say so.
   - A **write** maps a route to a table. The engine does a generic upsert by `id` (an `"op": "delete"` write sets the tombstone instead), so the app never hand-authors write SQL. The request body carries the record's fields — including the client-generated `id` and the `created`/`updated` timestamps (the app's own data); the engine adds the change bookkeeping below. Because every write is an id'd upsert, replaying it is idempotent.

   Build the app's Mac server as this same engine over `sync/queries.json`, not as bespoke route handlers — that is the whole point of the one-engine rule. The engine is a real file: copy `references/app-data-engine.mjs` verbatim into the app's `lib/` and have `server.mjs` forward every `/api` request to `createEngine({ db, queries }).handle({ method, path, query, body })`. Do not re-implement or edit it per app; it is the same contract the phone runs over its replica, and copying it verbatim is what makes "one engine, both sides" literally true.

2. **Writes carry a client-generated stable id and are idempotent.** The face generates the record's id (a UUID) at the moment of the tap, not the server. Every write is an upsert or is otherwise safe to apply twice, because an offline write is applied once on the phone immediately and again on the Mac at sync — and the phone may retry a write it never got an ack for. Never rely on an auto-increment id assigned by the database for identity; two devices offline would collide, and a replayed insert would double the row.

3. **Delete with a tombstone, never a hard `DELETE`.** Mark the row deleted (a `deleted` flag plus the change stamp below) instead of removing it. A hard delete cannot be represented as a change to pull, so a deletion made on the Mac would silently fail to reach the phone, and a row deleted offline would reappear on the next snapshot. Filter tombstoned rows out of the read queries.

4. **Stamp every row for change tracking and expose `_changes`.** Keep one app-wide monotonic change sequence (a single-row counter table bumped inside every write, or a per-write assignment — not a wall-clock timestamp; clocks skew and tie). Every table carries `change_seq` (set on every insert and update) alongside the `created`/`updated` timestamps the data layer already requires. Then expose one read-only endpoint:

   `GET /api/_changes?since=<seq>` → `{ changes: [ { table, id, row, deleted, change_seq } ... ], cursor: <highest change_seq returned> }`

   returning every row whose `change_seq` is greater than `since`, tombstones included, ordered by `change_seq`. This is the single endpoint the phone pulls after reconnecting to catch up its replica — including the results of its own just-replayed writes and anything the agent or the Mac changed meanwhile. Bake it in with the schema; it is not optional for an offline app.

   The Mac is where `change_seq` is assigned — authoritatively, on every write. The phone's optimistic offline write leaves `change_seq` unset and takes the canonical row (with its sequence) back on the next pull; the phone never invents a sequence of its own.

5. **Serve a full-copy snapshot so the phone can seed its replica.** `_changes` only carries what changed since a cursor; a phone that has never synced needs the whole database once. `server.mjs` adds one more route the phone hits on its first sync (and again if its copy falls too far behind):

   `GET /api/_snapshot` → the raw SQLite file bytes, with the current change-sequence high-water mark in an `X-Base-Seq` header (from `engine.currentSeq()`), so the phone's first `_changes?since=<baseSeq>` pull returns only what changed after the copy was taken. Checkpoint WAL into the main file before reading it so the bytes are complete:

   ```js
   if (req.method === 'GET' && url.pathname === '/api/_snapshot') {
     db.exec('PRAGMA wal_checkpoint(TRUNCATE)')          // fold the -wal file in so the .db is whole
     const baseSeq = engine.currentSeq()                 // capture before yielding; later writes belong in _changes
     const bytes = await readFile(DB_PATH)
     res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-base-seq': String(baseSeq) })
     return res.end(bytes)
   }
   ```

   The phone syncs by fetching `/api` cross-origin (its webview → the app's face URL), so every `/api`
   response needs permissive CORS and a preflight answer — the endpoint is loopback/LAN/WG-only, never
   internet-exposed, so `*` is fine:

   ```js
   res.setHeader('access-control-allow-origin', '*')
   res.setHeader('access-control-allow-headers', 'content-type')
   res.setHeader('access-control-expose-headers', 'x-base-seq')  // so the phone can read the snapshot's baseSeq
   if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }  // preflight for POST/DELETE replays
   ```

6. **Serve the built face bundle so the phone can render offline.** The replica gives the phone the app's
   *data*; it still needs the app's *screen*. While the Mac is reachable the phone caches the built static
   face (the same `web/dist` this server already serves) so it can render with no Node behind it. Add one
   route returning every built file plus the declared queries — Koda writes the files to the phone and runs
   the offline engine over the queries:

   `GET /api/_facebundle` → `{ files: [ { path, contentB64 }, … ], queries: <sync/queries.json> }`

   ```js
   if (req.method === 'GET' && url.pathname === '/api/_facebundle') {
     const files = []
     for (const rel of walkFiles(DIST_DIR)) {                 // every built file, path relative to web/dist
       files.push({ path: rel, contentB64: (await readFile(join(DIST_DIR, rel))).toString('base64') })
     }
     const queries = JSON.parse(await readFile(join(__dirname, 'sync', 'queries.json'), 'utf8'))
     res.writeHead(200, { 'content-type': 'application/json' })
     return res.end(JSON.stringify({ files, queries }))
   }
   ```

   The same permissive CORS applies (the phone fetches it cross-origin over the live link). The face bundle
   is refreshed on every live open, so a face you rebuild reaches the phone the next time it opens the app
   with the Mac awake. Offline the face uses ordinary same-origin `fetch('/api/…')` — Koda intercepts those
   locally — so make every data call with `fetch` (not `XMLHttpRequest`, which the offline shim doesn't
   cover) and send a write's body as a JSON string (`body: JSON.stringify(record)`); a `Blob`/`FormData`
   body is dropped offline. This is the ordinary way to call a JSON API anyway.

This is more disciplined than a throwaway CRUD layer, but it is good hygiene regardless (thin controllers, SQL declared once, stable ids, soft deletes) and it is the whole reason the app can work at the gym. Follow the `app-data` skill for the schema and migration craft; this contract is additive to it.

### What the platform does with the contract (so the shape makes sense)

You do not build any of this — it is Koda's job — but build the app knowing it happens:

- **The face bundle ships to the phone** and renders in its own web view at a private local origin. Its ordinary same-origin `fetch('/api/...')` calls are intercepted by the platform; there is no network hop offline.
- **Reads** run the named query for that route against a native SQLite **replica** of the app's database, filtered to live (non-tombstoned) rows.
- **Writes** are applied to the replica immediately (so the read the user takes next reflects their tap) and appended to a durable **outbox** — the literal request (method, path, body) — that survives the app being killed.
- **Sync** happens on app open (guaranteed) and, best-effort, from a background push when the Mac is reachable. The phone drains its outbox by replaying each queued request through the app's real `/api` write path on the Mac — the same validation, the same contract, no shortcut — then pulls `GET /api/_changes?since=<cursor>` and applies the results to the replica. Sync-on-open is the guarantee; the background push is a best-effort warm-up, so never assume the replica is fresh the instant the app foregrounds — paint from what is local, reconcile when the pull lands.
- **Conflicting edits resolve last-writer-wins; additive writes never conflict.** New records made offline carry their own ids, so they replay as inserts and coexist with anything changed on the Mac meanwhile — this is the common case and it is conflict-free. The only genuine conflict is the *same* record edited in both places during one offline window: the phone's queued write replays last, so it wins and the Mac's concurrent edit to that record is overwritten. That is the accepted single-owner v1 policy — no field-level merge, no CRDT (the one-authority model is what buys the simplicity). Design with it in mind: **prefer append-only records over in-place edits wherever the data allows** (a set logged is a new row, not a mutation of a running total), so history is additive and conflict-free by construction, and reserve in-place edits for genuinely correctable single values. If an app ever needs more, the cheap upgrades are keeping the newer edit or surfacing "also changed on your Mac" — not a merge engine.
- **A schema that no longer matches** (the app migrated on the Mac while the phone held an old replica) is resolved by discarding the phone's replica and taking a fresh snapshot, not by a distributed migration. This is safe precisely because the Mac is the one authority and the phone's only un-synced state is its outbox, which replays through the current write path. Drain the outbox before replacing the replica.

## The agent line offline

The face bridge that lets the app run agent turns (`koda:ask`, the handshake in the main skill) needs the Mac — an agent turn is the Mac's engine doing work. Offline it cannot run. Design for that: an app that owns its agent line should present it as unavailable when offline (dim it, or queue the intent and tell the user it will run when their Mac is reachable), never as a dead control that silently does nothing. If your app claimed the agent line, Koda tells you when to do this: the `koda:status` message carries `state: 'offline'` while the Mac is unreachable (alongside the existing `idle` / `working` / `needs-user`). Data entry and viewing keep working offline; only the agent line pauses.

## The face kit — feel is platform code

**Appearance belongs to the app; feel belongs to the platform.** Apps differ in look and personality (shadcn + the design direction from shaping) and are identical in physics — the split iOS itself makes. The physics ship as a copy-verbatim folder, exactly like `koda-face.js` and `app-data-engine.mjs`: **copy `references/face-kit/` verbatim into the face's source (e.g. `web/src/face-kit/`), import `face-kit.css` once in your entry css, and do not edit the kit per app.** It is headless — every primitive takes className props and renders zero visual opinion; skin them with the app's own tokens.

Build with the five, not around them:

| Primitive | Guarantees |
|---|---|
| `AppShell` | the safe-area frame from the inset variables, root scroll with no body rubber-band, the summon-corner reservation (drops when you pass `claimedLine` or a `bar`), keyboard-dismiss-on-scroll, a bottom `bar` slot that rides the keyboard |
| `Sheet` | the bottom sheet: springs up, tracks a drag-down, flick or 120px dismisses (light haptic), snaps back otherwise, pads above the keyboard, closes the keyboard under it, Reduce Motion swaps slide for fade |
| `Field` | inputs scroll into view above the keyboard, the return key reads "done" and actually closes the keyboard (`onEnter` fires your commit), `inputMode`/`type` pass through for the right keys |
| `Pressable` | tap states that respond instantly, hold a minimum visible beat, cancel when the finger slides away; optional `haptic` prop for actions that deserve one |
| `pick()` | attach: the real native picker when the shell lends it (`pick: true` in `koda:host`), a file-input fallback everywhere else; photos downscaled to a data-URL per the offline contract |

Every screen sits inside `AppShell`; every chooser or quick task is a `Sheet` (never a popover — a cursor shape); every text input is a `Field`; every button is a `Pressable`; every attach goes through `pick()`. The kit reads `koda-face.js`'s variables underneath — both files ship, koda-face.js first in `index.html`. Where the host lends nothing (a plain tab), every primitive degrades honestly on its own; you write no capability checks for feel.

## Rendering the face on the phone

This face lives on an iPhone first, full-bleed. The app owns its whole screen; Koda's only fixed fingerprint is the summon control it floats bottom-right for the agent line. If your app takes over its own agent line through the face bridge (`koda:claim-agent-line`), Koda hides that summon and the whole screen is yours (pass `claimedLine` to `AppShell`). If it does not, treat the bottom-right corner as occupied — never dock the app's own primary action there; `AppShell` reserves the space under scrolling content.

Honor iPhone chrome: `AppShell` clears the Dynamic Island, status bar, and home indicator for you (set `viewport-fit=cover` in `index.html` so the first paint is right). What stays yours: tap targets at least 44×44pt, primary actions in easy one-handed reach rather than up by the status bar, Reduce Motion respected in any motion you add beyond the kit's. Consult Apple's Human Interface Guidelines (developer.apple.com/design/human-interface-guidelines) fresh at build time, the same way you verify shadcn.

Every tap responds instantly. Whether the face is served live over the network or answered locally from the replica, the UI must never wait on a round trip before showing a result: update optimistically the moment the user acts, persist in the background, and reconcile on the response — rolling back with a brief notice only if the write actually failed. `setState(await api(...))` on a tap handler is a banned pattern; it feels fine on the Mac and laggy or broken everywhere else. When the face is served live, also keep the delivered payload lean — small bundle, lazy-load heavy or offscreen views, avoid oversized images and blocking work on first paint — because every asset crosses that link too. Paint something useful immediately and fill in the rest.

**Pin the production build in the app's build script, and check what you actually shipped.** You
build the face from inside a Koda session, which inherits `NODE_ENV=development` — and bundlers
resolve a framework's *development* build off that, so the face ships with its debug machinery
and doubled effects to the user's phone. Nothing warns you; the build succeeds and the app works.
Found in a real app on 2026-08-07: 571KB of development React, halved to 297KB by pinning it.
So write the script as `NODE_ENV=production <bundler> build` rather than bare `<bundler> build`,
and after a build confirm the output is production (for React, a bundle containing
`captureOwnerStack` is the development build). Treat an unexpectedly large bundle as this until
proven otherwise.

## iPhone idiom

To its user this is an iPhone app, and desktop-web patterns are the tell that it isn't one:

- **No pointer, no hover.** Nothing may depend on hover states, tooltips, hover reveals, or right-click — a touch screen never fires them. Every affordance is visible or one tap away; information a desktop would put in a tooltip goes inline or behind a tap.
- **Menus and pickers are sheets, not popovers.** A dropdown floating beside a cursor is a desktop shape. Choosing from a list is the kit's `Sheet` or a full-screen chooser, with options big enough to tap without aiming.
- **Navigate like an iPhone app.** A few top-level views get a bottom tab bar (`AppShell`'s `bar` slot); drilling into a record pushes a screen with a back affordance; a quick task on top of the current screen is a `Sheet`. A persistent sidebar or a desktop top-nav is wrong here.
- **Thumb reach.** Primary daily actions live in the lower half of the screen where a thumb lands; the top of the screen is for orientation and display, not controls.
- **Forms are chunky.** Full-width `Field`s, the right native keyboard per field (`inputMode`, `type="date"`), a big `Pressable` submit. Never a dense multi-column grid.
- **Motion is how the app feels alive.** The kit carries the baseline (the sheet's spring and drag, tap states); what stays yours is the app's own moments: a pushed screen slides in, a logged record settles into its list, and the payoff moment the app exists for (goal hit, streak extended, day complete) gets one designed beat — motion paired with a `success` haptic. A static face where things teleport between states reads as a webpage wearing an app's clothes, however correct its logic. Keep motion as feedback (short, eased or spring-like, tied to what the user did) and honor Reduce Motion by swapping movement for fades.

This decides the shadcn pick: sheet/drawer, tabs, switch, button, and card carry over well; hover-card, tooltip, context-menu, dropdown-menu, and popover need their trigger — or their whole shape — replaced with a tap-and-sheet equivalent before they belong on this screen.

Verify at an iPhone viewport (390×844), not a desktop browser window — a face that was only ever seen wide will hide its phone breakages until the user finds them.

## Native powers over the bridge

Inside Koda the face is one document below the top page, and iOS only tells the *top* page about the keyboard and screen edges — a nested frame never hears `visualViewport` shrink, and `env(safe-area-inset-*)` inside it is unreliable. Never reserve guessed keyboard space or hand-tune pixel offsets per device; that is the platform's job. Koda's phone shell is a native app holding measured truth, and it lends it (plus haptics and the camera) to the face over the same postMessage bridge as the agent line.

The `koda:host` reply names the powers that surface actually lends — `viewport: true`, `haptics: true`, and `pick: true` (the native photo/document pickers) on the phone, none of them on the desktop face. Treat every power as absent unless announced; the same face must degrade honestly on a host without it. The face kit already does this for you — its `haptic()` is silent and its `pick()` falls back to a file input on hosts that lend nothing — so the app never writes these capability checks itself.

**Layout: one set of inset variables, fed by the bridge inside Koda and by the web platform everywhere else.** This is the single most-skipped piece of a face, and getting it wrong is exactly what makes a generated app "not consider the iPhone" — its header hides under the Dynamic Island, its buttons sit under the home indicator, the keyboard covers an input. So the runtime that wires it is a **copy-verbatim file, not boot code you retype** (the same rule as `app-data-engine.mjs` — load-bearing glue ships as one file so it can't be skipped or drift):

**Copy `references/koda-face.js` verbatim** into the face's served static assets (e.g. `web/public/koda-face.js` — do not edit it per app) and include it once, before your app bundle, in `index.html`:

```html
<script src="/koda-face.js"></script>
```

That file installs three CSS variables and keeps them measured on every surface — from the bridge inside Koda, from `visualViewport` + `env()` as a home-screen app or a plain browser tab. Your layout reads only these three; it never calls `env()` or guesses a keyboard height directly:

```css
:root {
  /* koda-face.js seeds these (from env() until the bridge overrides) — declared here too for clarity. */
  --inset-top: env(safe-area-inset-top, 0px);
  --inset-bottom: env(safe-area-inset-bottom, 0px);
  --kb: 0px;
}
.app { padding-top: var(--inset-top); }             /* clear the status bar / island */
.bottom-bar { padding-bottom: var(--inset-bottom); } /* clear the home indicator */
.composer { padding-bottom: calc(var(--kb) + var(--inset-bottom)); transition: padding-bottom 0.25s ease; }
```

A bridge `safeBottom` of `0` while the keyboard is up is deliberate (the keyboard covers the home indicator); the `calc()` then pads by exactly the keyboard. `index.html` must also carry `viewport-fit=cover` in its viewport meta (koda-face.js patches it as a backstop, but set it yourself so the first paint is right). Anchor every top and bottom edge with these variables and content clears the island, buttons clear the home indicator, and inputs never hide under the keys on any surface.

**Haptics: the kit's `haptic(style)`** (which posts `{ type: 'koda:haptic', style }`), styles `light` (a committed action landed), `medium` (a heavier action), `success` (the payoff moment — something the user waited for finished), `warning` (attention). `Pressable`'s `haptic` prop covers the common case. Fire them only for deliberate user actions and genuine completions — a buzz on every event is noise, not feedback; the kit already stays silent on hosts without the power.

**Photos and files: the kit's `pick()`.** `pick({ kind: 'photo' })` / `pick({ kind: 'file', types: [...] })` presents the real native picker where the shell lends it and a file input everywhere else, and hands back downscaled base64. Store the result per the data contract: the data-URL goes IN the record's JSON body (`asDataUrl(file)`) — never a `Blob`/`FormData` upload, which the offline write path drops. For live capture, `<input type="file" accept="image/*" capture="environment">` opens the camera sheet and works on every surface, offline included — the right tool for "snap the meal." Live video (`getUserMedia`, for scanning/preview) is delegated by the host on live-served faces — feature-detect and fall back to the photo input, because the offline face's local origin does not support it, and iOS will show the system permission prompt on first use.
