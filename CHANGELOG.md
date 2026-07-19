# Changelog

All notable changes to Koda are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Koda uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is the canonical source: cutting a release moves the `Unreleased`
entries into a dated version section, which becomes both the GitHub release
notes and the in-app "What's New" popup. The public `/changelog` page mirrors it.

## [Unreleased]

_The iPhone app and its Mac connection ship as one launch entry when the phone
tier goes live. Fixes and features for that unshipped tier are not logged here as
they land — they are development on a feature no user can reach yet. The launch
gets one fresh marquee entry written as a capability, not a stack of dev-time
bullets. History for it lives in git and the project memory._

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

[Unreleased]: https://github.com/Gr0x01/koda/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/Gr0x01/koda/releases/tag/v0.1.6
[0.1.5]: https://github.com/Gr0x01/koda/releases/tag/v0.1.5
[0.1.4]: https://github.com/Gr0x01/koda/releases/tag/v0.1.4
[0.1.3]: https://github.com/Gr0x01/koda/releases/tag/v0.1.3
[0.1.2]: https://github.com/Gr0x01/koda/releases/tag/v0.1.2
[0.1.1]: https://github.com/Gr0x01/koda/releases/tag/v0.1.1
[0.1.0]: https://github.com/Gr0x01/koda/releases/tag/v0.1.0
