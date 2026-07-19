/**
 * THE status primitive: a tiny pixel-grid glyph renderer. A 6×6 matrix of cells, each lit or dark
 * from a bitmap — so the same primitive draws an idle dot, a checkmark, a ring, a "!", an "✕", or
 * (in `loader` mode) the soft "twinkle" shimmer that is Koda's ONE loading indicator. Cells are
 * `currentColor`, so tone is just a text-color class at the call site.
 *
 * Every idle/loading/done indicator routes through this (or `BusyText` below for inline
 * glyph-plus-label states) — never a plain CSS circle, a ring spinner, or bare "Working…" text.
 *
 * `size` is the rendered box in px — kept a touch smaller than the slot it sits in, so the pixel art
 * has breathing room rather than filling its bounds (e.g. ~13px inside a ~16-18px row icon column).
 * ~11px is the twinkle's legibility floor (inline beside text); below that it reads as noise.
 *
 * Every state — the glyphs and the twinkle — draws across the SAME full 6×6 grid (no dead margin).
 * Because the cell DOM is identical across states and only opacity changes, a state swap (idle →
 * twinkle → done/error/…) morphs in place via a CSS opacity transition rather than jumping or resizing.
 *
 * Add a glyph by drawing it: 6 strings × 6 chars, '#' = lit.
 */
import type { ReactNode } from 'react'

const N = 6

// Glyphs use the whole grid so the art is bold at ~13px (not a tiny shape in a big box). The twinkle
// loader spans the same full grid, so thinking resolves into the glyph across the same cells.
const GLYPHS = {
  // a bold diagonal check: short arm down-left to the vertex, long arm up to the top-right
  check: ['......', '.....#', '....#.', '.#.#..', '..#...', '......'],
  // a small centered ring (fresh, never-run session) — kept lighter than the bold states; an odd
  // diameter can't center in a 6-grid, so it's the centered diameter-4 ring rather than a 5.
  ring: ['......', '.####.', '.#..#.', '.#..#.', '.####.', '......'],
  // a bold exclamation (waiting on you)
  bang: ['..##..', '..##..', '..##..', '......', '..##..', '......'],
  // an ✕ (errored) — corners dropped so it reads at the same visual weight as the inset glyphs
  cross: ['......', '.#..#.', '..##..', '..##..', '.#..#.', '......'],
  // The idle dots — pixel replacements for a plain CSS circle, so idle → twinkle → done is one grid
  // morphing in place instead of an icon swap. Three weights for different situations (RB 2026-07-06):
  // `dot` = smallest/quietest (tight inline spots), `dotRound` = the default row-idle (reads as a
  // round dot with real mass — onboarding uses this), `dotBlock` = heaviest, reads as a block.
  dot: ['......', '......', '..##..', '..##..', '......', '......'],
  dotRound: ['......', '..##..', '.####.', '.####.', '..##..', '......'],
  dotBlock: ['......', '.####.', '.####.', '.####.', '.####.', '......'],
} as const

export type GlyphName = keyof typeof GLYPHS

/**
 * The loader has three motions, each carrying a distinct meaning across the SAME grid:
 *   - `twinkle` — the original full-grid shimmer (generic, kept as the default).
 *   - `diamond` — "the agent is reasoning": a block the whole grid rotates 45° into (so it reads as a
 *     sharp-tipped diamond) whose cells pulse from the center outward in concentric diamond rings — a
 *     thinking heartbeat. When the turn resolves the grid spins back upright (0°) while the cells
 *     cross-fade into the settled glyph — a spin-and-morph, not a cut.
 *   - `snake`   — a short lit segment chases the perimeter with a fading tail: generic "loading".
 * (A radar-pulse variant — rings breathing outward — is still kept in our pocket for later.)
 */
export type LoaderVariant = 'twinkle' | 'diamond' | 'snake'

// The diamond is drawn UPRIGHT as a centred square block, then the whole grid is rotated 45° (see the
// container transform) so it becomes a diamond with sharp single-cell tips an even grid can't draw
// axis-aligned. A 4×4 block keeps it inset so the rotated diamond stays within the icon's footprint.
const DIAMOND_BLOCK = ['......', '.####.', '.####.', '.####.', '.####.', '......']
function inDiamond(r: number, c: number): boolean {
  return DIAMOND_BLOCK[r][c] === '#'
}

// Pulse animation-delay (s) for a diamond cell: proportional to its Manhattan distance from the grid
// center (2.5, 2.5). Once the grid is rotated 45°, equal-distance cells form concentric diamond rings
// — center 4 (dist 1.0), edge cells (2.0), corner tips (3.0) — so brightness radiates out ring by ring.
function pulseDelay(r: number, c: number): number {
  const dist = Math.abs(r - 2.5) + Math.abs(c - 2.5)
  return (dist - 1.0) * 0.13
}

// Clockwise perimeter path — the ordered ring of border cells the snake's lit band marches along.
const SNAKE_PATH: Array<[number, number]> = []
for (let c = 0; c < N; c++) SNAKE_PATH.push([0, c])
for (let r = 1; r < N; r++) SNAKE_PATH.push([r, N - 1])
for (let c = N - 2; c >= 0; c--) SNAKE_PATH.push([N - 1, c])
for (let r = N - 2; r >= 1; r--) SNAKE_PATH.push([r, 0])
const SNAKE_LEN = SNAKE_PATH.length
// Perimeter index of a cell, or -1 for the (dark) interior.
function snakePos(r: number, c: number): number {
  return SNAKE_PATH.findIndex(([pr, pc]) => pr === r && pc === c)
}

/**
 * Twinkle loader: cells across the full grid softly flicker on fixed, scattered phases — an organic
 * "thinking" shimmer rather than a marching ring. Some cells stay dark so it reads sparse, not solid.
 */
// phases are animation-delays in seconds; the 1.6s cycle itself lives in the CSS keyframe.
const TWINKLE_DARK = 1.1 // a phase above this leaves the cell unlit, for sparseness
// fixed pseudo-random phase per cell (row-major across the full N×N grid)
const TWINKLE_PHASES = [
  0.0, 0.8, 1.4, 0.35, 1.1, 0.25,
  0.6, 1.3, 0.15, 0.9, 0.45, 1.45,
  1.2, 0.3, 0.7, 0.05, 1.35, 0.5,
  0.4, 0.95, 0.2, 1.25, 0.65, 0.85,
  1.4, 0.1, 0.55, 0.75, 0.3, 1.15,
  0.5, 0.65, 1.3, 0.4, 0.9, 0.2,
]

/** Twinkle phase (animation-delay in s) for a cell, or null to leave it dark. */
function twinkleDelay(r: number, c: number): number | null {
  const phase = TWINKLE_PHASES[r * N + c] ?? 0
  return phase > TWINKLE_DARK ? null : phase
}

export function PixelGlyph({
  glyph = 'check',
  loader = false,
  variant = 'twinkle',
  size = 13,
  label,
  className = '',
}: {
  glyph?: GlyphName
  loader?: boolean
  /** Which loading motion to draw (only meaningful while `loader`). See {@link LoaderVariant}. */
  variant?: LoaderVariant
  /** Rendered box in px (square). Drawn a little smaller than its slot on purpose. */
  size?: number
  label?: string
  className?: string
}) {
  const rows = GLYPHS[glyph]
  // Snap cells + gaps to whole DEVICE pixels. At these sizes a cell is ~1.9px; a fractional cell
  // straddles physical pixels and the browser averages it down, so some cells render solid and
  // others faded ("half filled-in"). Snapping trades a couple px of box size for uniform fill.
  const dpr = window.devicePixelRatio || 1
  const gap = Math.max(1, Math.round(Math.max(0.5, size * 0.045) * dpr)) / dpr
  const cell = Math.max(1, Math.round(((size - gap * (N - 1)) / N) * dpr)) / dpr
  const box = cell * N + gap * (N - 1)
  // Diamond mode rotates the whole grid: 45° while the shimmer runs, spinning back upright as it
  // settles into the glyph. The transition lives only on this mode so other glyphs never animate transform.
  const isDiamond = variant === 'diamond'
  const rotate = loader && isDiamond
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      className={`grid shrink-0 ${className}`}
      style={{
        width: box,
        height: box,
        gridTemplateColumns: `repeat(${N}, ${cell}px)`,
        gridAutoRows: `${cell}px`,
        gap,
        transform: isDiamond ? `rotate(${rotate ? 45 : 0}deg)` : undefined,
        transition: isDiamond ? 'transform 460ms cubic-bezier(0.2, 0.75, 0.2, 1)' : undefined,
      }}
    >
      {Array.from({ length: N * N }, (_, idx) => {
        const r = Math.floor(idx / N)
        const c = idx % N
        // Every cell is always a `bg-current` square whose BASE opacity is its glyph target (lit 1 /
        // dark 0). While loading it sits at 0 with a motion overlay on top; removing the overlay lets
        // each cell transition (koda-pixel-cell) to its target — the loader *settles into* the glyph
        // (forming cells lock to solid, the rest fade out) rather than cutting.
        if (loader && variant === 'snake') {
          // Perimeter cells march a lit band; interior stays dark. A negative per-cell delay spread
          // around the ring makes the band chase (see .koda-pixel-snake).
          const pos = snakePos(r, c)
          if (pos === -1) return <span key={idx} className="koda-pixel-cell bg-current" style={{ opacity: 0 }} />
          return (
            <span
              key={idx}
              className="koda-pixel-cell koda-pixel-snake bg-current"
              style={{ opacity: 0, animationDelay: `${-(pos / SNAKE_LEN) * 1.6}s` }}
            />
          )
        }
        // Diamond (agent thinking): a pulse that radiates out from the center. Every diamond cell shares
        // ONE keyframe on a delay set by its ring distance (pulseDelay), so brightness blooms from the
        // core outward in concentric diamond rings and holds a beat — a thinking heartbeat. The rest stay
        // dark; culling cells would break the silhouette into a lopsided blob.
        if (loader && variant === 'diamond') {
          if (!inDiamond(r, c)) return <span key={idx} className="koda-pixel-cell bg-current" style={{ opacity: 0 }} />
          return (
            <span
              key={idx}
              className="koda-pixel-cell koda-pixel-pulse bg-current"
              style={{ opacity: 0, animationDelay: `${pulseDelay(r, c)}s` }}
            />
          )
        }
        // full-grid twinkle: scattered cells shimmer, the rest stay dark for organic sparseness.
        const twinkle = loader ? twinkleDelay(r, c) : null
        if (twinkle !== null) {
          return (
            <span
              key={idx}
              className="koda-pixel-cell koda-pixel-twinkle bg-current"
              style={{ opacity: 0, animationDelay: `${twinkle}s` }}
            />
          )
        }
        const opacity = loader ? 0 : rows[r][c] === '#' ? 1 : 0
        // Diagonal stagger so a settled glyph wipes in top-left → bottom-right rather than all at once.
        // Only visible when opacity actually changes (the settle); a static idle render mounts at target.
        return (
          <span
            key={idx}
            className="koda-pixel-cell bg-current"
            style={{ opacity, transitionDelay: loader ? undefined : `${(r + c) * 22}ms` }}
          />
        )
      })}
    </div>
  )
}

/**
 * Inline busy state: the twinkle beside its label — the replacement for bare "Working…" /
 * "Checking…" spans. Inherits the caller's text color/size classes (the glyph rides `currentColor`),
 * so drop it wherever the plain span sat: `<BusyText>Working…</BusyText>`.
 */
export function BusyText({
  children,
  size = 12,
  variant = 'snake',
  className = '',
}: {
  children: ReactNode
  /** Glyph box in px. 12 suits 13px UI text; 11 is the floor for smaller inline text. */
  size?: number
  /** Inline busy states are generic "loading", so the snake is the default; pass `diamond` for agent thinking. */
  variant?: LoaderVariant
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <PixelGlyph loader variant={variant} size={size} />
      {children}
    </span>
  )
}
