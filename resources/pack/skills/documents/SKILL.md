---
name: documents
description: Create, place, or edit a markdown document for the user to read or share in Koda, or keep a conversation as one when they ask you to ("keep this", "save this as a document", "write that up"). Use before choosing the target for a memo, plan, report, draft, notes, or other user-facing `.md` file. Covers live `Documents/` lookup, extending the right existing document, what is worth keeping, and rich Koda formatting. Do not use for code documentation, hidden project memory, or a markdown file that is part of the code, such as a test fixture, a template, sample input, or a README.
user-invocable: false
---

Put user-facing writing in the project's `Documents/` folder, separate from code and from agent-facing `.koda/memory/` notes.

**Not every markdown file is a document.** A `.md` file the code owns is ordinary code work: a test fixture, a template, sample input, a README beside the module it explains, a note inside `.claude/` or `.koda/`. Write it where the code needs it, under the same judgment as any other source file. Nothing below applies to it, and the extension alone never makes a file the user's to read.

Before choosing a target:

1. Inspect the live `Documents/` folder and its topic subfolders. Do not rely on a cached folder map from session start.
2. Search for an existing document that already owns the topic. Extend it before creating a parallel memo, plan, or `-copy` file.
3. If a new document is warranted, put it in the existing topic subfolder it belongs to. Create a new subfolder only for a genuinely new topic; avoid loose root files when there is a clear home.
4. Match the length to the substance and leave the folder clean. If duplicate or dead documents have accumulated, offer consolidation as its own step rather than silently reorganizing unrelated writing.

**Every document opens with its metadata.** Koda writes that block when it makes the page, so a document created through Koda is already carrying `title`, `date`, `kind`, and the conversation it came out of. Two things are still yours. Add a one-sentence `description`, because it is the only line shown under the title when the user goes looking for something later, and a restatement of the title fills that slot without earning it. And correct the `kind` when the one Koda guessed from the folder is wrong: it is exactly one of `plan`, `decision`, `research`, `guide`, `reference`, `note`, and it is what the user filters the library by. When you write a document by hand instead, open the file with the same block and fill in all four. When you edit an existing document, leave its block where it is.

**When the user asks you to keep the conversation** — "keep this", "save this as a document", "write that up" — reach for Koda's `keep_document` tool (`mcp__koda_broker__keep_document`) instead of writing the file yourself. It creates the page through Koda's own path, so it is born with its title, date, kind and a record of the conversation it came out of; a hand-written file gets none of that. Do the filing above first: if a document already owns this topic, extend that one with an ordinary edit instead. The one-sentence `description` you pass is the only line shown under the title when the user is looking for something later, so make it say what the document is for. Restating the title there is worse than leaving it blank.

**Only when they ask.** Their request is the entire signal. Never decide on your own that a conversation was worth keeping, never write into `Documents/` in the background, and never offer to start a document unprompted. A library that fills itself behind the user's back is the thing this is shaped to avoid, and it is how a folder of writing someone trusts turns into a folder they stop reading.

**Keep what outlives the conversation, and nothing else.** Write the decisions, the conclusions, and the reasoning someone will need months from now. Not a transcript, and not a recap of the chat as it happened. A quiet stretch of work earns one dated line rather than a padded summary. When the conversation produced nothing durable, write nothing and say so plainly: an empty result is a valid result, and manufacturing content to fill it is the failure. If the user wants a document anyway, they will say so, and then you write it.

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

**Tables carry short facts, not prose.** A table earns its place when every cell is a number, a name, or a few words — things the eye compares down a column. The moment a cell wants a full sentence or a paragraph, the content belongs in headed prose or a list instead: a comparison across options reads far better as one short titled section per option than as a grid of paragraph-stuffed cells. If you're writing sentences into cells, stop and restructure.

**Structure long documents with headings.** A reader navigates a long page by its `##` sections (the doc surface shows a heading outline), so give a report real sections rather than one unbroken scroll. Link between documents with ordinary relative links (`[the plan](plans/roadmap.md)`) and within a page with anchor links (`[see results](#results)`) — both are clickable in the doc view.

**Keep documents portable.** The file is the source of truth, so below the metadata block stay in plain markdown plus the two blocks above — no other raw HTML, no invented syntax. How a page is laid out, its table column widths and whether it fills the window, is the user's to set and lives outside the file: you own the words and the structure, not the look.
