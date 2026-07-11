---
name: documents
description: Rich formatting for documents in Koda — callouts, collapsible toggles, and how docs render. Use when writing or editing a markdown document (.md) for the user to read, so it comes out as a polished page rather than flat text.
user-invocable: false
---

In Koda a `.md` file opens as a live, Notion-style page — so when you write a document for the user to read, you can reach beyond flat markdown for a few rich blocks. Use them when a document genuinely reads better for it; don't sprinkle them in.

**Callouts** — a tinted aside for a note, tip, or warning. Write a blockquote whose first line is a marker:

```
> [!NOTE]
> Worth knowing, but not the main point.
```

Markers: `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`. Each renders with its own colour and icon.

**Toggles** — a collapsible section the reader can expand. Write an HTML `<details>`:

```
<details><summary>Click to expand</summary>

The hidden content goes here — any markdown works inside.

</details>
```

The `<summary>` is the always-visible title; everything until `</details>` is the collapsible body.

**Everything else is normal markdown** and already renders well: GFM tables (the user can drag to resize columns), task lists (`- [ ]`), fenced code with a language hint, images, headings, links.

**Keep documents portable.** The file is the source of truth, so stay in plain markdown plus the two blocks above — no other raw HTML, no invented syntax. A page's emoji icon, cover image, and table column widths are the user's to set and live outside the file: you own the words and the structure, not the look.
