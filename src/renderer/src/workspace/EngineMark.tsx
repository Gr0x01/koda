import type { EngineId } from '@shared/ipc'
import { engineShort } from './models'

type MarkDefinition = {
  tone: string
  Glyph: ({ size }: { size: number }) => React.JSX.Element
}

/** Identity lives in one exhaustive registry. A future provider adds its glyph/tint here once; every
 *  session row and picker gets it without learning another engine-name branch. */
const MARKS: Record<EngineId, MarkDefinition> = {
  claude: { tone: 'text-claude', Glyph: ClaudeMark },
  codex: { tone: 'text-codex', Glyph: CodexMark },
}

/**
 * The 12px brand mark on a session row's meta line, saying whose engine ran the thread.
 *
 * This file names engines on purpose, and it is the ONLY thing it is allowed to do with the name —
 * see its entry in `shared/engine-name-branches.test.ts`. The mark is identity, the same category as
 * `accountLabel` and the two engine pickers: a row reports which engine ran, it never decides
 * anything from the answer. Isolating it here rather than allowlisting `SessionRow.tsx` keeps the
 * tripwire tight over the row itself, where a real behavior branch could otherwise hide unnoticed.
 *
 * The tint is load-bearing, not decoration. At 12px a `text-muted` glyph disappears into the meta
 * line entirely, which defeats the point of it being there — so Claude carries a warm clay (inside
 * Koda's warm-neutral family, DESIGN.md §2) and Codex a neutral graphite, far enough apart to read at
 * a glance without either becoming a second accent.
 *
 * Both shapes are placeholders. Neither vendor's real logo paths are vendored into this repo.
 */
export function EngineMark({
  engineId,
  className = '',
}: {
  engineId: EngineId
  className?: string
}): React.JSX.Element {
  const { tone, Glyph } = MARKS[engineId]
  return (
    <span aria-label={engineShort(engineId)} className={`shrink-0 ${tone} ${className}`}>
      <Glyph size={12} />
    </span>
  )
}

/** The larger, softly tinted mark used wherever provider identity is itself interactive. These are
 *  Koda's own geometric marks—not vendored or traced vendor logos. */
export function ProviderMark({
  engineId,
  size = 'compact',
  className = '',
}: {
  engineId: EngineId
  size?: 'compact' | 'regular'
  className?: string
}): React.JSX.Element {
  const { tone, Glyph } = MARKS[engineId]
  const frame =
    size === 'regular'
      ? 'size-[30px] rounded-[9px] bg-current/10'
      : 'size-5 rounded-md bg-current/10'
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center ${tone} ${frame} ${className}`}
    >
      <Glyph size={size === 'regular' ? 16 : 12} />
    </span>
  )
}

function ClaudeMark({ size }: { size: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 2.5v19M2.5 12h19M5.2 5.2l13.6 13.6M18.8 5.2 5.2 18.8" />
    </svg>
  )
}

function CodexMark({ size }: { size: number }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2.6 20.4 7.3v9.4L12 21.4 3.6 16.7V7.3z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}
