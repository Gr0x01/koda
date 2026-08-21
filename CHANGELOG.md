# Changelog

All notable changes to Koda are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Koda uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is the canonical source: cutting a release moves the `Unreleased`
entries into a dated version section, which becomes both the GitHub release
notes and the in-app "What's New" popup. The public `/changelog` page mirrors it.

## [Unreleased]

## [0.1.12] - 2026-08-21

### Added

- Press ⌘K for the Library, one place to create or find anything you and Koda have written.
  Search by title, words inside the page, type, or date. You can also ask a question across
  your documents and past chats. Koda lists the sources it used, and a chat source opens
  that conversation.
- Say “keep this as a document” and Koda writes the useful result into your Documents folder
  only when you ask. The document remembers which chat it came from. Star a document to keep
  it in the sidebar, where it stays available across chats. The star also sits on an open
  document's Stage bar, beside the hold-view pin, so you can keep or release the document you
  are reading without a trip through the Library.
- Documents now open ready to read and switch to Edit when you want to type. Changes save as
  you go, failed saves offer a retry, and selecting a passage shows how much text will travel
  with your message to Koda.
- Agents can now put a primary document, source location, or diff on the correct session's Stage.
  The Mac respects a held or hidden Stage; the phone adds it quietly and keeps it through reconnects.
- Each completed turn gets a separate **This turn** file set derived from its recovery point, so the
  exact files and diffs remain available after the agent saves the work and ordinary Changes is clean.
- Links in agent replies can open contained project documents and source locations on Mac or phone,
  including paths with spaces, `file://`, `#L12C3`, and `path:line:column` forms.
- Settings now lets you choose how Koda writes session names and saved-version descriptions,
  using the same provider-first model catalog as chat. Apple Intelligence stays on your Mac,
  Plain local text uses no AI, and Claude and Codex each open their own model list with a
  separate reasoning control, using your configured provider account.
- Goal is now a shared Claude and Codex playbook. Invoke it to keep pursuing one concrete outcome
  through verification instead of stopping at a plan or progress update.
- Koda now includes Deep Review for changes that need a closer look. It follows related code,
  tests, and history, checks suspected problems, and gives the change an evidence-backed score.
  It is available on Claude and Codex when you ask for it.

### Changed

- The Stage now keeps several things open as tabs. An app, document, diff, terminal, and agent
  roster can stay together, and a narrow window moves the Stage over the conversation so both
  remain readable.
- Versions is now one timeline. Unsaved work sits at the top, saved versions run below it, side
  work branches from the point where it began, and the GitHub boundary and push action sit on
  the same line.
- A turn's commands and file work now fold into one timed work line. When a chat sends work to
  several agents, one fleet row opens a full Agents roster where you can inspect or stop each
  live agent.
- The sidebar is a quieter chat list. Each row shows what changed and moves the rest into a
  hover card. Archived chats and recent images open from compact lines at the bottom, and old
  chats stay in one list until you choose to archive them. Files now open through ⌘P and
  documents through the Library.
- Model selection now opens inside the current AI provider, with a distinct Koda mark and a short
  explanation for each curated model. Switching between Claude and Codex lives one level deeper, so
  the everyday menu stays compact and can grow cleanly as Koda adds providers.
- A successful overnight memory tidy now saves its own clean memory changes as one local version
  before the Dream appears in the morning. That version lands on whatever line of work the project is
  on that night and is credited to Koda Dream, so overnight saves stay easy to recognize in your
  history. Pre-existing or overlapping edits stay unsaved, and Koda never creates a Git repository
  for an unversioned folder just to make that version.
- Koda now matches planning and review to the size of the work. Agents open job-specific
  playbooks when useful, check which Koda tools actually loaded, and show one Preview mock when
  a screen needs a real design choice. Koda also answers more briefly after the work is done.
- Usage now shows the full API value of your work, what caching saved, recent model costs, token
  splits, and a daily chart. Short Claude turns that name a chat or describe a save count too.
  Providers without a published price stay in tokens.
- Background checks slow down when Koda is out of sight or your Mac is on battery. Update checks
  pause while the screen is locked or the Mac is asleep, then refresh when you return.
- Codex Plan mode now blocks project changes for the whole planned turn, and changing its
  approval mode no longer restarts the chat. Koda's finishing guidance now chooses one matching
  review lane, verifies repairs directly, and keeps Deep Review behind an explicit request.
- The bundled Codex engine is updated to 0.147.0.

### Fixed

- Normal Codex work is no longer steered or interrupted by Koda after a fixed number of inference
  steps or tokens. The separate per-tool output cap remains to prevent oversized tool results.
- New chats no longer open with a false "Some Koda abilities didn't load: Browser testing" warning.
  The current engine stopped listing Koda's internal browser playbook in its startup inventory, so
  the check reported a healthy capability as broken in every session; browser testing now reads from
  the browser tools the engine actually loaded.
- Documents recover automatically when a live development update leaves the editor on a stale
  module graph, including a rapid burst of updates that one recovery alone could not outlast. Each
  recovery now has to prove itself with a clean editor open: when the problem persists, Koda stops
  after a few attempts and shows its recovery screen, instead of silently reloading the window and
  closing the document you just opened every time you retry. If opening the editor genuinely fails,
  Koda now says that instead of calling it a save error and offering a Retry action that cannot help.
- Chats now move between Needs you and Active based on what you can act on. Working in two chats
  no longer leaves a permanent Needs check badge; each chat claims the files it changed, and a
  shared file names both chats.
- Stopping a turn now stops its delegated agents first. A chat stays working until its last agent
  finishes, and files written by those agents stay attached to the chat that sent them.
- Archived chats stay archived even when a very long transcript reaches the live-session size
  limit. Repeated archive rows for the same chat also fold back into one.
- Session names stop being rewritten by tool-only turns or a missed naming request. Desktop chats
  also keep their true origin after a reload instead of returning with a phone label.
- New chats now remember the complete provider, model, and reasoning choice. Changing reasoning no
  longer falls back to the engine default when the next chat starts.
- A Preview or Agents roster pushed by an agent in a background chat now brings that chat and its
  Stage forward, instead of leaving the result hidden behind the session picker.
- A brand-new chat no longer announces "continuing on" the model you just picked. That banner is
  reserved for a session that genuinely restarts under an existing conversation.
- Saved-image cleanup now runs when a project opens, when the setting changes, and as files age
  in a quiet project.
- Restoring an earlier version now tells every open agent which files moved back. A chat whose
  engine lost its earlier history resumes on a fresh engine conversation and tells you once.
- The Stage keeps a readable conversation beside it, Preview drops its green mark when its server
  stops, and merged branches reconnect to the version where they really began.
- Various fixes improve screen-reader labels, sidebar menus, session attention, generated names,
  document actions, and recovery after an engine reconnect.

## [0.1.10] - 2026-08-11

### Added

- In projects that use Git, agents now save each finished task as a local
  version you can return to. Continuing work stays together, and a genuinely
  new coding topic starts from the project's main line. The Versions view labels
  each workspace as Ready, Needs cleanup, or Needs a check.
- Koda can now split independent parts of a job across fresh agents in
  parallel. Each one has its own visible task card, and you can stop one without
  ending the rest of the session.
- A fresh pair of eyes is now part of finishing substantial work. Screens,
  pages, and documents are opened and checked against the agreed standard before
  you see them. Code changes get a bug review, and finished features get an
  architecture review for duplicate or competing parts. These checks use more
  of your plan and can be turned off in Settings → General → Finishing work.
- Koda can now tidy project memory overnight and leave a dated journal for the
  morning. Anything that needs your judgment is flagged for you. The feature is
  off by default and can be turned on in Settings → Memory.
- Changes to Koda's guardrails, recovery store, or app settings now always ask
  for your approval, even in Auto-approve. The approval card explains why.
- Messages about Claude or OpenAI outages now link to that service's status
  page.

### Changed

- Codex now shows command output and plan progress while it works. When it
  shortens a long conversation, Koda says so and refreshes the context meter.
  Plan-usage percentages also stay in order when account updates arrive at the
  same time.
- Agents now use the right built-in guide for each job and spend less of your
  usage allowance rereading general instructions.
- Documents opens with folders closed and remembers which ones you open. Folders
  that contain no documents stay in Files, and the agent sees how Documents is
  already organized before it writes something new.
- Saying no to an action now covers the outcome. The agent asks what you would
  prefer next.
- Dictation on macOS 26 now uses Apple's newest on-device speech engine for
  sharper punctuation, names, and technical words. Older macOS versions keep
  the previous on-device engine.
- The bundled Claude engine is updated to 2.1.221.

### Fixed

- Koda no longer replaces saved chats, archives, project lists, settings, or up
  to 90 days of usage history when one of those files cannot be read. It
  preserves the original, keeps a recovery copy when needed, pauses risky
  writes, and tells you what happened.
- Koda now tells you when a change was saved without an undo point. Edits that
  would destroy existing work stop when the recovery point fails. A brand-new
  empty project also gets a proper first point in its recovery timeline.
- Attaching an image now works the same from a drop or the attach menu. JPEG,
  PNG, GIF, and WebP files that can be sent are available in both places. A file
  Koda cannot attach is named in the composer while the rest of the batch stays
  attached.
- A downloaded update stays ready until you restart, even after another update
  check or a stretch without internet.
- Claude plan usage now shows the 5-hour, weekly, and per-model windows at
  ordinary usage levels. A reset notification fires once when a limit truly
  clears.
- A chat keeps its approval mode through reconnects, model changes, and other
  background refreshes. Pending approval cards also return if Koda's window
  reloads.
- Various fixes improve app relaunches, model selection, cloud sign-in recovery,
  outage messages, document mentions with spaces, and guidance when you ask for
  a service Koda cannot reach.

## [0.1.9] - 2026-07-31

### Added

- Documents got room to breathe. Wide tables no longer get crushed into the
  narrow reading column — they spread out toward the edge of the pane so a
  comparison actually reads like one. A new control in the top corner of any
  doc switches the whole page to full width (and remembers your choice per
  document).
- Save a document as a PDF. File → Export as PDF… turns the doc you're reading
  into a clean, print-ready PDF — pick where to save it and it opens right up,
  ready to share with anyone who doesn't have Koda.
- Find inside a document. Press ⌘F while working in a doc and a small find bar
  searches just that document, with next and previous. ⌘F in the conversation
  still searches the conversation, like before.
- An outline for long documents. A subtle set of dashes on the right edge of a
  doc marks its sections — hover to see the section names, click one to jump
  there. It highlights where you are as you scroll.
- Links inside documents now work. A link to another document opens it, a link
  to a section jumps to it, and a web link opens in your browser — before,
  clicking a link in a doc did nothing.
- Spellcheck now works the way you expect. Misspelled words in the message box
  or a document have always been underlined, but right-clicking one did
  nothing. Now you get spelling suggestions, an Add to Dictionary option, and
  the usual Cut, Copy and Paste menu in any text field.
- Drag files out of Koda. A file or folder from the Files or Documents list can
  now be dragged straight into Finder, Mail, or a browser upload box, the same
  way dragging into Koda already worked. Moving things between folders inside
  Koda works the same as before.
- Session names now tell each other apart. Working on the same thing across
  several sessions used to name them all identically. Once a session's first
  round of work finishes it renames itself after what was actually done, then
  stays put — and if a name would exactly repeat one already in use, the date
  is added to tell them apart. A name you typed yourself is never touched.
- Right-click the Koda icon in the Dock to jump straight to a recent project or
  start a new one.

### Fixed

- Links to your own documents open in Koda. When Koda writes a document and links
  to it in the conversation, clicking that link now opens it right there in the
  Stage instead of kicking you out to your web browser. Links to real websites
  still open in your browser as before.
- Resizing table columns in a document works again. Hover the border between
  two columns and drag to set their widths; the widths stick when you reopen the
  document.
- Open Recent now brings an already-open project back into view. Previously, a
  project window that was hidden or minimized could make the menu look like it
  did nothing.
- Adding a picture from Recent images no longer creates another copy of it.
  Repeated clicks also keep only one copy attached to the message.

## [0.1.8] - 2026-07-24

### Added

- Claude Opus 5, Anthropic's newest top model, now works in Koda. It came out
  yesterday; if your model is set to Opus you get it automatically. The bundled
  Claude engine was updated to support it.
- Do more with a change than just save it. Each file in your Changes list now
  offers its own actions: see what changed, open the file to read or edit it,
  reveal it in Finder, or undo that one change. Hover a file for the quick
  buttons, or right-click it for the full list.
- Open an image and see the picture. PNGs, JPGs, GIFs, SVGs, WebP and more now
  show right in the workspace instead of a "binary file" notice.
- Your Claude usage meter now shows a real percentage, just like the Codex one.
  Anthropic recently started sharing exact usage numbers, so instead of a vague
  green-or-amber dot you see "79%" and can plan your day around it.

### Fixed

- The usage dot now actually turns amber when you're closing in on your weekly
  Claude limit. Anthropic renamed the warning signal and its weekly window, so
  Koda was showing a calm green dot (and hiding the weekly gauge in Settings)
  even at 79% used. The tooltip also explains the 5-hour line instead of
  silently dropping it when there's nothing to report, and the "limit has reset"
  notification now covers the weekly limit too, not just the 5-hour one.

- When your AI account is signed out, Koda now says so plainly and gives you a
  Sign in button that takes you straight there, instead of a cryptic "please run
  /login" message with no way to act on it. The provider dot at the bottom of the
  window also turns amber with a "sign in" prompt so you catch it before you even
  send a message. It only ever shows for the provider you're actually using, so a
  Codex-only user is never nagged to sign into Claude, or the other way around.

- Opening a project now starts you in your Koda folder, where your projects
  actually live, instead of whatever folder your Mac last had open.

- "Point at files or folders" in the attach menu now lets you select several at
  once (Cmd-click or Shift-click), instead of making you go back for each one.

## [0.1.7] - 2026-07-20

### Added

- Koda now ends each piece of work by telling you what changed in plain words,
  including anything it touched that you did not ask for. If it takes a quiet
  detour, you catch it right away, while undo is still one step away.
- Pin the documents you use most. Right-click a document and choose Pin, and it
  stays at the top of your Docs list while keeping its place in your folders.
  Drag pinned documents to put them in the order you like.
- See your documents by when they were last worked on. A new clock button above
  the Docs list flips it to a most-recent-first view, grouped by day, including
  documents Koda itself just wrote for you.

### Changed

- The new-project setup now gives you real room to describe your idea. The
  writing box is bigger, grows as you type, and the wording invites the full
  picture instead of a one-liner. The more you share up front, the better Koda
  sets up your project.
- The light and dark switch is no longer in the bottom bar. You can still
  choose light, dark, or follow your Mac under Settings, then Appearance.

### Fixed

- The message box no longer collapses on you. In some cases it would shrink so
  far that your typing was pushed out of view, leaving only the top sliver of
  the placeholder text visible. It now keeps its proper height.
- Your Codex usage meter now stays current. It could sit frozen at an old
  number, and on a plan with only a weekly limit it could show a mislabeled
  5-hour window that never moved. Koda now checks your real usage after each
  turn and shows whichever limit actually applies to your plan.
- Right-click menus in the sidebar now stay fully on screen. Opening one near
  the bottom or right edge of the window used to cut it off.
- Codex keeps Koda's Preview and recovery tools available after the first
  message instead of silently losing them when it refreshes its tool connections.
- Codex now opens pages and apps in Koda's Preview when it says it will. Its
  Preview instructions were naming a tool that did not exist, so it could
  promise to show you a finished page and then stop without opening anything.

## [0.1.6] - 2026-07-19

### Added

- You can now hand Koda files, not just pictures. Drag a CSV or PDF into the
  chat (or paste it), and Koda keeps a copy and reads it. This is great for
  importing data or working from a document. A new + button in the message box
  also lets you pick files, or point Koda at any file or folder on your Mac
  without copying anything.
- Pages and screens Koda builds for you now go through a real design pass. It
  picks a look made for your project, with its own colors and type, instead of
  falling back on the same generic template every time.
- When a conversation gets long, a "Keep going in a fresh chat" button now
  appears next to the fullness meter. Tap it and Koda writes a short handoff of
  where you left off, then opens a fresh chat carrying it over, so you can keep
  going at full speed without losing the thread. The old chat stays put.
- The Mac File menu now has the project basics where you expect them. Make a
  document or folder, open a recent project, import files, reveal the project
  in Finder, copy its path, or close its window. Koda still saves continuously,
  so there is no Save command to remember.
- You can now delete a project from the home screen. Hover over it in the
  recent list (or right-click it), type the project's name to confirm, and
  Koda stops anything the project is running and moves its folder to the Trash.
  You can always put it back if you change your mind.
- Each engine's status now shows in the bottom bar. The small dot next to Claude
  or Codex is a health light. It stays calm when all is well and turns amber the
  moment that provider has trouble, with the honest word for it (outage,
  degraded, or maintenance). So when something feels off, you can tell at a
  glance whether it is you or them. It refreshes the moment you come back to the
  window.
- The send button now does double duty, like you may know from other chat apps.
  When the message box is empty it is a microphone, so you can tap to dictate. As
  soon as you type or attach something, it smoothly turns into the send arrow.

### Changed

- The AI settings now give each provider its own tab. Pick Claude or Codex at
  the top and you see just that account and its usage, instead of one long stack
  of everything at once. Each provider's sign-in status shows right in its
  header, and the option to use your own API key is tucked behind an advanced
  toggle so the everyday view stays simple.
- The light and dark switch moved from the strip at the very top of the window
  down to the bottom status bar, next to Settings. The top of the window stays
  calm, and day or night mode is still one click away.
- When Koda asks you a multiple-choice question and you type your own reply
  instead of picking an option, the conversation now keeps showing the question
  you were asked, not just a note that you answered in your own words.
- If you have Koda tell you when Claude is back after an outage, a single failed
  message is now enough to start watching. You no longer have to retry to make it
  notice. Anthropic's status page often lags behind what you are already seeing,
  so Koda watches quietly in the background from your first failed message and
  still catches the recovery once the page catches up.
- Updated the bundled Claude engine to 2.1.205.

### Fixed

- The model you pick now actually runs. If you started a new chat and sent a
  message without re-opening the model selector, Koda could quietly run a
  different model than the one shown. You would pick Sonnet and get Opus. Your
  choice is now honored from the very first message.
- Deleting a project now clears its chat history for good. Before, an old
  project's conversations could reappear if you later made a new project with
  the same name in the same place. Fresh start now means fresh.
- If you delete a project's folder from your Mac, it no longer lingers as a
  dead tile in your recent projects. And if you bring the folder back, the
  project shows up again on its own.

## [0.1.5] - 2026-07-17

### Added

- Choose how long archived chats are kept. They stay forever by default. If you
  prefer to keep things tidy, you can now have Koda automatically delete archived
  chats older than a week, a month, or three months. The setting lives in Settings
  under Archived sessions.

### Changed

- Koda opens faster when you have a lot of archived chats. Archived conversations
  are now stored so that having hundreds of them no longer slows down startup.
- The little status icons now tell you what is happening at a glance. When the
  assistant is thinking, its icon becomes a softly shimmering diamond that spins
  into a checkmark once it is done. When Koda is loading something, a small dot
  traces around the icon instead. Same quiet pixel style, easier to read.
- The "memory needs a tidy" reminder now shows up far less often. Koda's assistant
  keeps its own notes about your project tidy as it works, clearing out finished
  items on its own instead of letting them pile up, so you are nudged to tidy only
  when it is really needed.

### Fixed

- When Claude asks you a multiple-choice question, your answer now stays on screen
  after you pick it. It used to show the choices again as if you never answered, so
  you couldn't tell what you'd picked. The card now keeps showing your selection.
- The Codex usage details now label the 5-hour and weekly limits correctly. They
  could show up swapped, so the 5-hour limit appeared to reset days away. The
  reset times now line up with the right window, and when Codex does not say how
  long a window lasts, Koda no longer guesses "5-hour" for one that resets days
  from now.

## [0.1.4] - 2026-07-15

### Changed

- Organizing Documents now works like a proper Mac file list. Folders can be
  renamed, duplicated, revealed in Finder, or deleted from their visible menu;
  new documents and folders land inside the folder you selected, and new
  folders ask for a name right away. Arrow-key navigation and familiar rename,
  duplicate, delete, and new-document shortcuts work too.
- Sub-folders in the Documents list now nest and indent under their parent, so a
  folder inside a folder reads as a tidy tree instead of a full path written out
  on one line.
- Selecting text in a document now opens one clear editing control instead of
  separate formatting and agent-action bubbles. Format the text normally, or
  switch the same control into Koda's rewrite actions without losing your
  selection.

### Fixed

- Images in a document now show up in the document view. A picture you reference
  by its file (like one in an `assets` folder next to the document) used to come
  up blank; now it renders inline where you wrote it.
- Making a new folder in Documents no longer drops it inside a folder just
  because you opened that folder to look inside. Use a folder's arrow to open and
  browse it, and click its name when you want new items to go there. The New
  folder and New document buttons now show where the new item will land.
- The live Preview now opens when you use the Codex engine, not only the Claude
  engine.

## [0.1.3] - 2026-07-13

### Added

- Point the agent at one of your documents by typing `@` in the message box.
  Start typing the name, pick it from the list, and a reference drops in, so you
  no longer have to hunt the file down and open it first.
- Drag files in from Finder to add them to your project. Drop them on a folder
  to file them there, or anywhere in the panel to bring them in.
- Right-click a file or document for the everyday Mac shortcuts: Reveal in
  Finder, Copy path, Open in its usual app, and Duplicate.
- Manage your writing straight from the Documents list too. Rename or delete a
  document, drag one onto a folder to file it, and make new folders right there.
  A deleted document can be brought back from the recovery timeline.
- Archived sessions (Settings → Archived sessions) now expand to preview the
  last few messages, so you can recognize which chat is which before you restore
  it.
- Koda now tells you when the agent's project notes have grown heavy enough to
  slow it down. A "memory needs a tidy" notice appears in the status bar, and
  Settings → Memory shows the size and offers a one-button tidy that asks the
  agent to condense its own notes. Nothing gets deleted, and the tidy is
  undoable like any other change.

### Changed

- The agent now keeps its project notes lean as your project grows. It updates
  the note it already has on a topic instead of piling on a new one, folds notes
  about replaced approaches into the current one, and keeps its running list of
  work to one line per item. Long-running projects stay fast instead of slowly
  filling up.
- The agent now keeps your Documents organized as they add up. It groups related
  documents into folders instead of leaving a pile of loose files at the top,
  puts each new document where it belongs, and offers to tidy up when the folder
  gets cluttered.

### Fixed

- Right-click menus (like Rename or Archive on a session) now have a clearly
  defined edge in the light theme, instead of blending into the background.

## [0.1.2] - 2026-07-12

### Added

- When you ask for a whole new app or feature, the agent now helps you shape it
  first. It asks the few questions that actually change what gets built,
  suggests things you might not have thought of, and points out what a first
  version leaves out so you can ask for it next. It also will not talk you out
  of a big idea just because it sounds like a lot of work.

### Changed

- The update banner and its download progress are cleaner and easier to read.

### Fixed

- The model picker no longer jumps while you are reaching for it. The OpenAI
  models used to pop in a moment after the menu opened and shove the Claude
  models up under your cursor. The menu now opens at its full height right away.
- When a longer background task finishes while you are away, its result now
  shows up on your next message instead of getting lost.

## [0.1.1] - 2026-07-11

_A maintenance update. Nothing changes in how you use Koda._

### Changed

- Internal update to how Koda delivers new versions. No action needed.

## [0.1.0] - 2026-07-09

_First versioned build — the baseline the auto-updater ships from._

### Added

- In-app auto-update: Koda checks for new versions on launch and in the
  background, downloads them quietly, and asks you to restart when one is ready.
  Updates are never installed silently.
- "What's New" appears once after an update with a short summary of what changed.
- Settings now shows the Koda version, the bundled Claude engine version, and a
  "Check for updates" button.

[Unreleased]: https://github.com/Gr0x01/koda/compare/v0.1.12...HEAD
[0.1.12]: https://github.com/Gr0x01/koda/releases/tag/v0.1.12
[0.1.10]: https://github.com/Gr0x01/koda/releases/tag/v0.1.10
[0.1.9]: https://github.com/Gr0x01/koda/releases/tag/v0.1.9
[0.1.8]: https://github.com/Gr0x01/koda/releases/tag/v0.1.8
[0.1.7]: https://github.com/Gr0x01/koda/releases/tag/v0.1.7
[0.1.6]: https://github.com/Gr0x01/koda/releases/tag/v0.1.6
[0.1.5]: https://github.com/Gr0x01/koda/releases/tag/v0.1.5
[0.1.4]: https://github.com/Gr0x01/koda/releases/tag/v0.1.4
[0.1.3]: https://github.com/Gr0x01/koda/releases/tag/v0.1.3
[0.1.2]: https://github.com/Gr0x01/koda/releases/tag/v0.1.2
[0.1.1]: https://github.com/Gr0x01/koda/releases/tag/v0.1.1
[0.1.0]: https://github.com/Gr0x01/koda/releases/tag/v0.1.0
