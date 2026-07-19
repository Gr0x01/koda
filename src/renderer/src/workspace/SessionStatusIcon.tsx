import type { SessionStatus } from './store'
import { PixelGlyph, type GlyphName } from '../ui'

const ICON_SIZE = 13

/**
 * Live session status as a PIXEL-GRID icon (design experiment). One grid renders both the loader and
 * the resolved state: while a turn runs it twinkles, and when the turn ends the twinkle *settles into*
 * the glyph — the cells that form the shape lock to solid, the rest fade out in place (see PixelGlyph;
 * each cell's base opacity is its glyph target, the twinkle is an overlay). A true morph, not a cut.
 *
 * State → glyph: thinking → twinkle · waiting → ! · error → ✕ · idle → check (or a hollow ring when
 * the session is fresh and has never run a turn).
 */
export function StatusIcon({
  status,
  fresh = false,
  attention = false,
  className = '',
}: {
  status: SessionStatus
  fresh?: boolean
  attention?: boolean
  className?: string
}) {
  const loading = status === 'thinking'
  // The glyph the twinkle resolves into — also the base shape underneath while loading.
  const glyph: GlyphName =
    status === 'waiting' ? 'bang' : status === 'error' ? 'cross' : fresh ? 'ring' : 'check'
  const label = loading
    ? 'Working…'
    : status === 'waiting'
      ? 'Waiting on you'
      : status === 'error'
        ? 'Errored'
        : fresh
          ? 'Ready, nothing sent yet'
          : 'Ready'
  // The fresh ring sits lighter than the bold states; everything else shares the same muted ink.
  const tone = fresh ? 'text-text-muted/50' : 'text-text-muted/70'
  const pulse = attention && status === 'waiting' ? 'animate-pulse' : ''

  return (
    <PixelGlyph
      glyph={glyph}
      loader={loading}
      variant="diamond"
      size={ICON_SIZE}
      label={label}
      className={`${tone} ${pulse} ${className}`}
    />
  )
}
