// Generates Koda's pixel-K brand assets (mark, wordmark, lockup, app icon) from the locked bitmaps.
// Single source of truth for the SVGs so they can be regenerated if the grid ever changes.
//
// Run:   node scripts/gen-brand-assets.mjs
// Then rasterize the app icon for electron-builder (auto-detected at build/icon.png):
//        rsvg-convert -w 1024 -h 1024 assets/koda-icon.svg -o build/icon.png
import { writeFileSync } from 'node:fs'

const INK = '#2549A8'
const WHITE = '#FFFFFF'

// 7x7 pixel K — single-column stem, 45° arms (matches PixelGlyph's 6x6 status family in spirit)
const K7 = ['.#...#.', '.#..#..', '.#.#...', '.##....', '.#.#...', '.#..#..', '.#...#.']
// letters trimmed to ink (5 wide), for even wordmark spacing
const L = {
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  d: ['....#', '....#', '.####', '#...#', '#...#', '#...#', '.####'],
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
}

const rects = (bitmap, C, G, ox, oy, fill, rx) => {
  const out = []
  for (let r = 0; r < bitmap.length; r++)
    for (let c = 0; c < bitmap[r].length; c++)
      if (bitmap[r][c] === '#') {
        const x = ox + c * (C + G)
        const y = oy + r * (C + G)
        out.push(`<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="${rx}" fill="${fill}"/>`)
      }
  return out.join('\n  ')
}

// ---- mark: white K on an ink tile, 7x7 centered in 1024 ----
{
  const T = 1024, C = 73, G = 15, rx = 12
  const span = 7 * C + 6 * G
  const pad = (T - span) / 2
  const svg = `<svg width="${T}" height="${T}" viewBox="0 0 ${T} ${T}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>Koda mark</title>
  <rect width="${T}" height="${T}" fill="${INK}"/>
  ${rects(K7, C, G, pad, pad, WHITE, rx)}
</svg>
`
  writeFileSync(new URL('../assets/koda-mark.svg', import.meta.url), svg)
}

// ---- wordmark: ink "Koda" on transparent, letters spaced 1 blank column apart ----
{
  const C = 40, G = 8, rx = 6
  const cols = [] // [bitmap, colOffset]
  let x = 0
  for (const ch of 'Koda') {
    cols.push([L[ch], x])
    x += L[ch][0].length + 1 // +1 blank column between letters
  }
  const totalCols = x - 1
  const w = totalCols * C + (totalCols - 1) * G
  const h = 7 * C + 6 * G
  const body = cols.map(([bm, off]) => rects(bm, C, G, off * (C + G), 0, INK, rx)).join('\n  ')
  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>Koda wordmark</title>
  ${body}
</svg>
`
  writeFileSync(new URL('../assets/koda-wordmark.svg', import.meta.url), svg)
}

// ---- lockup: ink-tile K icon + pixel "oda" → reads "Koda", the tile K is the capital ----
{
  const C = 40, G = 8, rx = 6
  // icon tile (mini mark), square, with its own inner padding
  const iC = 30, iG = 6, iRx = 5
  const iSpan = 7 * iC + 6 * iG
  const iPad = 40
  const tile = iSpan + iPad * 2
  const gapToWord = 44
  const word = ['o', 'd', 'a']
  let wx = 0
  const wcols = word.map((ch) => { const o = wx; wx += L[ch][0].length + 1; return [L[ch], o] })
  const wCols = wx - 1
  const wordW = wCols * C + (wCols - 1) * G
  const wordH = 7 * C + 6 * G
  const W = tile + gapToWord + wordW
  const H = Math.max(tile, wordH)
  const tileY = (H - tile) / 2
  const wordY = (H - wordH) / 2
  const iconRects = rects(K7, iC, iG, iPad, iPad, WHITE, iRx)
  const wordRects = wcols.map(([bm, off]) => rects(bm, C, G, tile + gapToWord + off * (C + G), wordY, INK, rx)).join('\n  ')
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>Koda logo</title>
  <g transform="translate(0 ${tileY})">
    <rect width="${tile}" height="${tile}" rx="${Math.round(tile * 0.22)}" fill="${INK}"/>
    ${iconRects}
  </g>
  ${wordRects}
</svg>
`
  writeFileSync(new URL('../assets/koda-logo.svg', import.meta.url), svg)
}

// ---- app icon: "raised chips" — each white pixel a physical tile (bevel gradient + drop shadow) ----
{
  const T = 1024, C = 72, G = 14, rx = 12
  const span = 7 * C + 6 * G
  const pad = (T - span) / 2
  const dy = Math.round(C * 0.09), blur = Math.round(C * 0.08)
  const chips = []
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++)
      if (K7[r][c] === '#') {
        const x = pad + c * (C + G), y = pad + r * (C + G)
        chips.push(`<rect x="${x}" y="${y}" width="${C}" height="${C}" rx="${rx}" fill="url(#chip)" filter="url(#drop)"/>`)
      }
  const svg = `<svg width="${T}" height="${T}" viewBox="0 0 ${T} ${T}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>Koda app icon</title>
  <defs>
    <linearGradient id="chip" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dbe2f1"/>
    </linearGradient>
    <filter id="drop" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="${dy}" stdDeviation="${blur}" flood-color="#0a1740" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="${T}" height="${T}" rx="${Math.round(T * 0.225)}" fill="${INK}"/>
  ${chips.join('\n  ')}
</svg>
`
  writeFileSync(new URL('../assets/koda-icon.svg', import.meta.url), svg)

  // iOS variant: identical chips, but a FULL SQUARE tile (rx=0) — iOS masks its own corners and
  // rejects transparency, so the ink fills the whole 1024 and there are no rounded/transparent edges.
  const svgIos = svg.replace(
    `<rect width="${T}" height="${T}" rx="${Math.round(T * 0.225)}" fill="${INK}"/>`,
    `<rect width="${T}" height="${T}" fill="${INK}"/>`
  )
  writeFileSync(new URL('../assets/koda-icon-ios.svg', import.meta.url), svgIos)
}

console.log('wrote koda-mark.svg, koda-wordmark.svg, koda-logo.svg, koda-icon.svg, koda-icon-ios.svg')
