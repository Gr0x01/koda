# Changelog

All notable changes to Koda are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Koda uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is the canonical source: cutting a release moves the `Unreleased`
entries into a dated version section, which becomes both the GitHub release
notes and the in-app "What's New" popup. The public `/changelog` page mirrors it.

## [Unreleased]

## [0.1.0] - 2026-07-09

_First versioned build — the baseline the auto-updater ships from._

### Added

- In-app auto-update: Koda checks for new versions on launch and in the
  background, downloads them quietly, and asks you to restart when one is ready.
  Updates are never installed silently.
- "What's New" appears once after an update with a short summary of what changed.
- Settings now shows the Koda version, the bundled Claude engine version, and a
  "Check for updates" button.

[Unreleased]: https://github.com/Gr0x01/koda-public/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Gr0x01/koda-public/releases/tag/v0.1.0
