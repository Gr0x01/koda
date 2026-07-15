# Changelog

All notable changes to Koda are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Koda uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is the canonical source: cutting a release moves the `Unreleased`
entries into a dated version section, which becomes both the GitHub release
notes and the in-app "What's New" popup. The public `/changelog` page mirrors it.

## [Unreleased]

### Added

- Edit your documents from your phone, not just read them. Open a document in the
  phone app and tap the edit button to write in it like a normal page — headings,
  lists, checklists, tables, and callouts all work, the same as on your Mac. Your
  changes save back to your Mac on their own when you tap Done, and every save can
  be undone.

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

[Unreleased]: https://github.com/Gr0x01/koda/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Gr0x01/koda/releases/tag/v0.1.4
[0.1.3]: https://github.com/Gr0x01/koda/releases/tag/v0.1.3
[0.1.2]: https://github.com/Gr0x01/koda/releases/tag/v0.1.2
[0.1.1]: https://github.com/Gr0x01/koda/releases/tag/v0.1.1
[0.1.0]: https://github.com/Gr0x01/koda/releases/tag/v0.1.0
