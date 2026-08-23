#!/usr/bin/env python3
"""Regenerate the binary document fixtures (sample.docx, sample.pdf).

Run from this directory:  python3 make-fixtures.py

Why a script instead of one `textutil` line: macOS's own DOCX writer silently drops images. Verified
on macOS 26.5.2 — `textutil -convert docx` from HTML *and* from RTFD both produce a package with no
`word/media/` entry, so the "DOCX with an embedded image" fixture cannot come from it. This assembles
the package directly from the stdlib instead, which also keeps the bytes deterministic (fixed zip
timestamps) so a regeneration that changes nothing produces no diff.

The PDF still uses a real macOS path: text is handed to `cupsfilter`, which runs Apple's own
`cgtexttopdf`, so the fixture is a genuine one-page Quartz PDF with a real text layer.

Both fixtures carry the same content on purpose, so a Slice 1-4 test can compare what each format
surface extracted against a single known document.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

HERE = Path(__file__).resolve().parent
FIXED_TIME = (2026, 8, 20, 0, 0, 0)  # deterministic zip entries

TITLE = "Quarterly service review"
INTRO = (
    "Prepared for the operations handoff. Numbers cover April through June and come from the weekly "
    "duty roster, not the ticket system, so a shift that opened no tickets still counts."
)
TABLE = [
    ("Region", "Shifts covered", "Escalations", "Median response"),
    ("North", "91", "4", "12 min"),
    ("South", "88", "9", "21 min"),
    ("West", "93", "2", "9 min"),
]
BULLETS = [
    "Rebalance the South roster before the next quarter starts.",
    "Publish the escalation ladder where the on-call person can find it at 2 a.m.",
    "Retire the paper handoff sheet; two regions already stopped filling it in.",
]
CAPTION = "Escalations by month, April through July."

IMAGE_W, IMAGE_H = 180, 96
EMU_PER_PIXEL = 9525  # 96 dpi


def chart_png() -> bytes:
    """A tiny four-bar chart, drawn by hand so the fixture needs no image library."""
    bg, ink, axis = (246, 248, 252), (47, 95, 208), (190, 198, 212)
    rows = [[bg for _ in range(IMAGE_W)] for _ in range(IMAGE_H)]
    for x in range(IMAGE_W):
        rows[IMAGE_H - 12][x] = axis
    for left, height in ((14, 58), (62, 74), (110, 40), (150, 20)):
        for x in range(left, min(left + 34, IMAGE_W)):
            for y in range(IMAGE_H - 12 - height, IMAGE_H - 12):
                rows[y][x] = ink
    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", IMAGE_W, IMAGE_H, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
"""

DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
</Relationships>
"""

CORE_PROPS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>{TITLE}</dc:title>
  <dc:description>Koda test fixture: a DOCX with headings, a table, a list, and an embedded image.</dc:description>
  <dc:creator>Koda fixtures</dc:creator>
  <cp:lastModifiedBy>Koda fixtures</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-08-20T00:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-08-20T00:00:00Z</dcterms:modified>
</cp:coreProperties>
"""

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def style(style_id: str, name: str, size_half_points: int, bold: bool, outline: int | None) -> str:
    outline_xml = f'<w:outlineLvl w:val="{outline}"/>' if outline is not None else ""
    bold_xml = "<w:b/>" if bold else ""
    return (
        f'<w:style w:type="paragraph" w:styleId="{style_id}">'
        f'<w:name w:val="{name}"/>'
        f'<w:pPr><w:spacing w:before="240" w:after="120"/>{outline_xml}</w:pPr>'
        f'<w:rPr>{bold_xml}<w:sz w:val="{size_half_points}"/></w:rPr>'
        f"</w:style>"
    )


STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:styles {W_NS}>"
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">'
    '<w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
    + style("Title", "Title", 56, True, 0)
    + style("Heading1", "heading 1", 40, True, 0)
    + style("Heading2", "heading 2", 30, True, 1)
    + '<w:style w:type="paragraph" w:styleId="ListParagraph">'
    '<w:name w:val="List Paragraph"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>'
    "</w:styles>"
)

NUMBERING = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:numbering {W_NS}>"
    '<w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>'
    '<w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>'
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    "</w:numbering>"
)


def escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def paragraph(text: str, style_id: str | None = None, bullet: bool = False) -> str:
    props = ""
    if style_id:
        props += f'<w:pStyle w:val="{style_id}"/>'
    if bullet:
        props += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
    props_xml = f"<w:pPr>{props}</w:pPr>" if props else ""
    return f"<w:p>{props_xml}<w:r><w:t xml:space=\"preserve\">{escape(text)}</w:t></w:r></w:p>"


def table_xml() -> str:
    borders = "".join(
        f'<w:{edge} w:val="single" w:sz="6" w:space="0" w:color="B4BFCF"/>'
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV")
    )
    rows = []
    for index, row in enumerate(TABLE):
        cells = []
        for value in row:
            run = f'<w:r>{"<w:rPr><w:b/></w:rPr>" if index == 0 else ""}<w:t>{escape(value)}</w:t></w:r>'
            cells.append(
                '<w:tc><w:tcPr><w:tcW w:w="2340" w:type="dxa"/></w:tcPr>'
                f"<w:p>{run}</w:p></w:tc>"
            )
        rows.append(f'<w:tr>{"".join(cells)}</w:tr>')
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        f'{"".join(rows)}</w:tbl>'
    )


def image_xml() -> str:
    cx, cy = IMAGE_W * EMU_PER_PIXEL, IMAGE_H * EMU_PER_PIXEL
    return (
        "<w:p><w:r><w:drawing>"
        f'<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
        '<wp:docPr id="1" name="Chart" descr="Bar chart of escalations for April, May, June, and July"/>'
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:nvPicPr><pic:cNvPr id="1" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId3"/>'
        "<a:stretch><a:fillRect/></a:stretch></pic:blipFill>"
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic></wp:inline>"
        "</w:drawing></w:r></w:p>"
    )


def document_xml() -> str:
    body = [
        paragraph(TITLE, "Title"),
        paragraph(INTRO),
        paragraph("Coverage by region", "Heading1"),
        table_xml(),
        paragraph(""),
        paragraph("Escalations by month", "Heading1"),
        image_xml(),
        paragraph(CAPTION),
        paragraph("Follow-ups", "Heading2"),
        *[paragraph(text, "ListParagraph", bullet=True) for text in BULLETS],
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f"<w:document {W_NS}><w:body>{''.join(body)}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        "</w:body></w:document>"
    )


def write_docx(target: Path) -> None:
    parts = {
        "[Content_Types].xml": CONTENT_TYPES.encode(),
        "_rels/.rels": ROOT_RELS.encode(),
        "docProps/core.xml": CORE_PROPS.encode(),
        "word/_rels/document.xml.rels": DOCUMENT_RELS.encode(),
        "word/document.xml": document_xml().encode(),
        "word/styles.xml": STYLES.encode(),
        "word/numbering.xml": NUMBERING.encode(),
        "word/media/chart.png": chart_png(),
    }
    with ZipFile(target, "w", ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            info = ZipInfo(name, date_time=FIXED_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


def plain_text() -> str:
    lines = [TITLE, "", INTRO, "", "Coverage by region", ""]
    widths = [max(len(row[i]) for row in TABLE) for i in range(len(TABLE[0]))]
    for row in TABLE:
        lines.append("  ".join(value.ljust(widths[i]) for i, value in enumerate(row)).rstrip())
    lines += ["", "Escalations by month", "", CAPTION, "", "Follow-ups", ""]
    lines += [f"- {text}" for text in BULLETS]
    return "\n".join(lines) + "\n"


def write_pdf(target: Path) -> None:
    """Apple's own text-to-PDF filter, so the fixture is a real one-page Quartz PDF."""
    if not shutil.which("cupsfilter"):
        sys.exit("cupsfilter not found: sample.pdf can only be regenerated on macOS.")
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "sample.txt"
        source.write_text(plain_text(), encoding="utf-8")
        result = subprocess.run(
            ["cupsfilter", "-i", "text/plain", str(source)],
            capture_output=True,
            check=True,
        )
    if not result.stdout.startswith(b"%PDF-"):
        sys.exit("cupsfilter did not return a PDF.")
    target.write_bytes(result.stdout)


def main() -> None:
    docx, pdf = HERE / "sample.docx", HERE / "sample.pdf"
    write_docx(docx)
    write_pdf(pdf)
    print(f"sample.docx  {docx.stat().st_size:>7,} bytes")
    print(f"sample.pdf   {pdf.stat().st_size:>7,} bytes")


if __name__ == "__main__":
    main()
