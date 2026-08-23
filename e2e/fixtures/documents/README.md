# Document fixtures

Representative artifacts for Koda's typed-document work (`Documents/plans/Typed Documents and
Artifact Surfaces — implementation plan.md`, Slice 0). One known document appears in several formats
so a test can compare what each format surface read, rendered, or refused against the same content.

These are test inputs. Nothing here is one of the user's documents, and nothing here is wired into
the product.

| File | What it is |
| --- | --- |
| `report-with-artifact-link.md` | A short authored Markdown document with Koda frontmatter, a table, a list, and an ordinary relative link to `interactive-report.html`. The link is deliberately plain Markdown: outside Koda it is a normal clickable link, inside Koda it is what a smart artifact card has to render from. |
| `interactive-report.html` | A well-behaved self-contained interactive document. Inline CSS and JS, real interactivity (two sliders and a toggle that recompute a table), and zero external resources: no fonts, stylesheets, scripts, images, or requests. |
| `hostile.html` | **A security fixture.** Its inline script attempts external `fetch`, `window.top`/`window.parent` navigation, Node reachability probes, Electron/IPC probes, an `XMLHttpRequest` against `file://`, form-action exfiltration, `window.open`, `sendBeacon`, an external tracking pixel, and cookie/storage writes. Every attempt must fail in a correct sandbox. See below for how to assert that. |
| `sample.docx` | A real DOCX package with a title, two heading levels, a bordered table, a bulleted list, and an embedded PNG chart in `word/media/`. |
| `sample.pdf` | One page of real, selectable text carrying the same content as `sample.docx`. |
| `make-fixtures.py` | Regenerates the two binary fixtures. Not a fixture. |

## Asserting against `hostile.html`

Each probe appends one `<tr data-probe="…" data-outcome="…">` row and one entry to
`window.__kodaHostileResults`. `data-outcome` is `blocked` when the attempt threw, rejected, or
errored, and `ALLOWED` when it completed, which is a real escape. When every probe has settled the
document sets `body[data-state="settled"]` and `body[data-escaped]` to the number of `ALLOWED` rows.

Three probes — `navigate top`, `navigate parent`, and `form exfil` — record a third outcome,
`attempted`. A browser drops a sandboxed form submission and a blocked top or parent navigation
*silently*: no exception, no return value, and the document is forbidden from reading `top`/`parent`
to see whether anything moved. (The same-origin policy permits the cross-origin `location.replace`
call, so it does not throw; the sandbox blocks the actual navigation.) Neither `blocked` nor
`ALLOWED` would be an honest answer from inside the frame, so the fixture reports the attempt and the
harness — which can see Koda's own window — asserts nothing moved.

A passing security test waits for `data-state="settled"`, asserts `data-escaped` is `"0"`, and
checks each `attempted` probe's effect from outside the frame.

There are no real secrets and no real endpoints. Every host is under `.invalid.example`, a name that
cannot resolve, so the fixture is inert even if it is ever opened outside a sandbox.

## Regenerating the binary fixtures

From this directory, on macOS:

```sh
python3 make-fixtures.py
```

That writes both `sample.docx` and `sample.pdf`. Zip entries carry a fixed timestamp, so a
regeneration that changes no content produces no diff.

**Why a script and not one `textutil` line.** macOS's own DOCX writer silently drops images: on
macOS 26.5.2, `textutil -convert docx` produces a package with no `word/media/` entry from an HTML
source *and* from an RTFD source that does contain the image. So the script assembles the OOXML
package directly with the Python standard library. The PDF still comes from a genuine macOS path:
the script hands plain text to `cupsfilter -i text/plain`, which runs Apple's `cgtexttopdf`.

Verifying a regeneration (all four were run against the committed files):

```sh
unzip -l sample.docx                 # valid zip; word/media/chart.png present
textutil -convert txt -stdout sample.docx   # macOS reads back the headings, table cells, bullets
head -c 5 sample.pdf                 # %PDF-
qlmanage -t -s 900 -o /tmp/ql sample.docx sample.pdf   # Apple's renderer draws both
```

Keep every fixture small. The binaries are a few KB and tens of KB respectively, well under the
100 KB ceiling, and the lab's source envelope carries them without complaint.
