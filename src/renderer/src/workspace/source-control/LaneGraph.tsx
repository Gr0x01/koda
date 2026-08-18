import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Lane, TimelineRow } from './timeline'

/**
 * The rail: an SVG lane graph drawn beside the timeline rows, aligned to what those rows actually
 * measure. Row heights come from their content (a card wraps differently at 200px than at 500px, and
 * the bundle grows when you expand it), so the geometry is measured rather than assumed — a dot that
 * drifts off its row turns the whole picture into decoration.
 *
 * Layout: the rail is an absolutely-positioned SVG; the rows are padded past it. Each row's dot sits
 * at the row's vertical center, unless the row marks a different anchor with `data-lane-anchor` (the
 * bundle anchors to its head line so expanding it doesn't drag the stubs down).
 *
 * The rail is only as wide as the lanes it actually draws. The panel ships at 300px, where a fixed
 * gutter sized for three lanes would spend a quarter of the width on nothing on the calm day that is
 * most days.
 */

const MAIN_X = 28
/** x for a side lane. Open work caps at three; rare overlapping completed loops can widen the rail. */
const laneX = (column: number): number => 44 + column * 12
/** Clearance right of the outermost drawn thing, so a tip circle never touches the text. */
const LANE_PAD = 12
/** Spine only: enough for the dot plus a breath. */
const MIN_RAIL = 52
const STUB_X = [MAIN_X + 16, MAIN_X + 24, MAIN_X + 32]

/**
 * How much vertical run a lane spends peeling off the spine (and settling back onto it).
 *
 * This number is the whole difference between a graph and a smudge. A lane leaving the spine has to
 * leave it VERTICALLY — tangent along the line it is departing — then settle into its own vertical
 * run. That is a cubic whose two control points share the MIDPOINT Y: P0=(MAIN_X,y) P1=(MAIN_X,ym)
 * P2=(x,ym) P3=(x,y-BEND). Tangent at both ends is (0,-BEND/2): straight up.
 *
 * Putting both control points at the lane's x instead — which is what this drew before, and what the
 * prototype it came from drew — makes the tangent at the dot nearly horizontal, so the line shoots
 * sideways out of the commit and balloons. Clamped to half the span so a one-row merge tucks in
 * rather than overshooting past its own endpoints.
 */
const BEND = 24

/** The peel: a smooth S from `(from, y)` on the spine up to `(x, y - k)` in the lane. */
function peel(x: number, y: number, k: number): string {
  const mid = y - k / 2
  return `C ${MAIN_X} ${mid} ${x} ${mid} ${x} ${y - k}`
}

// Tailwind needs literal class strings, so the tones live in maps rather than being built from parts.
// Each picks a darker step for light mode: at 2px, a mid-tone line on warm paper reads as a smudge.
const LANE_STROKE: Record<'live' | 'loose', string> = {
  live: 'stroke-emerald-600 dark:stroke-emerald-500',
  loose: 'stroke-amber-600 dark:stroke-amber-500',
}

/** How wide the rail has to be for everything this timeline draws. */
function railWidth(lanes: Lane[]): number {
  let need = MIN_RAIL
  for (const lane of lanes) {
    if (lane.kind === 'bundle') need = Math.max(need, STUB_X[2] + 10)
    else need = Math.max(need, laneX(lane.column) + LANE_PAD)
  }
  return need
}

export function LaneGraph({
  rows,
  lanes,
  boundaryRow,
  seamRow,
  renderRow,
}: {
  rows: TimelineRow[]
  lanes: Lane[]
  /** First row that is confirmed on GitHub; null ⇒ nothing confirmed, so the whole line reads local. */
  boundaryRow: number | null
  seamRow: number | null
  renderRow: (row: TimelineRow, index: number) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const [centers, setCenters] = useState<number[]>([])
  const [total, setTotal] = useState(0)

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    const next = rows.map((_, i) => {
      const el = rowRefs.current[i]
      if (!el) return 0
      const anchor = el.querySelector<HTMLElement>('[data-lane-anchor]') ?? el
      const box = anchor.getBoundingClientRect()
      return box.top - top + box.height / 2
    })
    const height = container.getBoundingClientRect().height
    setCenters((prev) =>
      prev.length === next.length && prev.every((v, i) => Math.abs(v - next[i]) < 0.5) ? prev : next,
    )
    setTotal((prev) => (Math.abs(prev - height) < 0.5 ? prev : height))
  }, [rows])

  useLayoutEffect(() => {
    rowRefs.current.length = rows.length // drop refs to rows that no longer exist
    measure()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    for (const el of rowRefs.current) if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [measure, rows.length])

  // Web fonts land after the first paint and reflow every row; re-measure once they're in so the dots
  // don't sit half a line off until the next resize.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (!fonts) return
    let alive = true
    void fonts.ready.then(() => {
      if (alive) measure()
    })
    return () => {
      alive = false
    }
  }, [measure])

  const y = (row: number): number => (row >= centers.length ? total : (centers[row] ?? 0))
  const boundaryY = boundaryRow === null ? null : y(boundaryRow)
  const seamY = seamRow === null ? null : y(seamRow)
  const width = railWidth(lanes)
  const githubUnknown = rows.some((row) => row.t === 'commit' && row.onGitHub === null)

  return (
    <div ref={containerRef} className="relative">
      {total > 0 && (
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={total}
          viewBox={`0 0 ${width} ${total}`}
          fill="none"
          aria-hidden
        >
          {/* The spine: accent while it is confirmed local-only, quiet once GitHub has a copy, and
              dashed-neutral when the remote state cannot support a per-version claim. */}
          {githubUnknown ? (
            <line
              x1={MAIN_X}
              y1={0}
              x2={MAIN_X}
              y2={total}
              className="stroke-text-muted"
              strokeWidth={2}
              strokeOpacity={0.5}
              strokeDasharray="3 3"
            />
          ) : (
            <line
              x1={MAIN_X}
              y1={0}
              x2={MAIN_X}
              y2={boundaryY ?? total}
              className="stroke-accent"
              strokeWidth={2}
              strokeOpacity={0.85}
            />
          )}
          {!githubUnknown && boundaryY !== null && (
            <line
              x1={MAIN_X}
              y1={boundaryY}
              x2={MAIN_X}
              y2={total}
              className="stroke-text-muted"
              strokeWidth={2}
              strokeOpacity={0.45}
            />
          )}

          {lanes.map((lane) =>
            lane.kind === 'open' ? (
              <OpenLane
                key={lane.key}
                x={laneX(lane.column)}
                from={y(lane.fromRow)}
                to={y(lane.toRow)}
                tone={lane.tone}
                beyondWindow={lane.fromRow >= rows.length}
              />
            ) : lane.kind === 'inflow' ? (
              <InflowLane
                key={lane.key}
                x={laneX(lane.column)}
                from={y(lane.fromRow)}
                to={y(lane.toRow)}
                beyondWindow={lane.beyondWindow}
              />
            ) : (
              <BundleStubs key={lane.key} at={y(lane.atRow)} />
            ),
          )}

          {seamY !== null && (
            <line
              x1={Math.max(4, MAIN_X - 14)}
              y1={seamY}
              x2={Math.min(width - 2, MAIN_X + 18)}
              y2={seamY}
              className="stroke-border"
              strokeWidth={1}
            />
          )}

          {rows.map((row, i) => {
            if (row.t === 'commit')
              return <CommitDot key={row.key} y={y(i)} onGitHub={row.onGitHub} merge={row.merge} />
            // A brought-in commit sits on its merge's lane. Match by identity rather than row span:
            // complete loops can overlap vertically while occupying different columns.
            if (row.t !== 'inflow') return null
            const lane = lanes.find(
              (l) => l.kind === 'inflow' && l.mergeSha === row.mergeSha,
            ) as Extract<Lane, { kind: 'inflow' }> | undefined
            if (!lane) return null
            return <InflowDot key={row.key} x={laneX(lane.column)} y={y(i)} />
          })}
        </svg>
      )}

      <div style={{ paddingLeft: width }}>
        {rows.map((row, i) => (
          <div
            key={row.key}
            ref={(el) => {
              rowRefs.current[i] = el
            }}
          >
            {renderRow(row, i)}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A side line that never came back: forks off the spine, climbs, and ends in an open tip at its card. */
function OpenLane({
  x,
  from,
  to,
  tone,
  beyondWindow,
}: {
  x: number
  from: number
  to: number
  tone: 'live' | 'loose'
  /** The fork is older than the loaded window, so the lane runs off the bottom instead of joining. */
  beyondWindow: boolean
}) {
  const stroke = LANE_STROKE[tone]
  const k = Math.min(BEND, Math.max(8, from - to))
  const d = beyondWindow
    ? `M ${x} ${from} L ${x} ${to}`
    : `M ${MAIN_X} ${from} ${peel(x, from, k)} L ${x} ${to}`
  return (
    <>
      <path d={d} className={stroke} strokeWidth={2} strokeOpacity={0.8} fill="none" />
      <circle cx={x} cy={to} r={4.5} className={`${stroke} fill-bg`} strokeWidth={2} />
    </>
  )
}

// A muted sage rather than Tailwind's emerald: at 2px against ink, emerald-400 is the loudest thing
// on the rail, and it is spent on the least load-bearing mark there.
const INFLOW_STROKE = 'stroke-[#4f8a5c] dark:stroke-[#7fb886]'

/**
 * The branch a merge brought in: it peels down off the merge dot, runs behind that merge's commits,
 * then folds back into the spine at the real fork. If the fork is older than the loaded window, the
 * line continues offscreen. A hollow tip is deliberately absent: that mark belongs to unfinished
 * side work, and putting it on a completed merge is what made the branch look detached.
 */
export function InflowLane({
  x,
  from,
  to,
  beyondWindow,
}: {
  x: number
  from: number
  to: number
  beyondWindow: boolean
}) {
  const k = Math.min(BEND, Math.max(8, (to - from) / 2))
  const leaveMid = from + k / 2
  const leave = `M ${MAIN_X} ${from} C ${MAIN_X} ${leaveMid} ${x} ${leaveMid} ${x} ${from + k}`
  const d = beyondWindow
    ? `${leave} L ${x} ${to}`
    : `${leave} L ${x} ${to - k} C ${x} ${to - k / 2} ${MAIN_X} ${to - k / 2} ${MAIN_X} ${to}`
  return <path d={d} className={INFLOW_STROKE} strokeWidth={2} strokeOpacity={0.75} fill="none" />
}

/** One commit a merge brought in. Smaller than a spine dot: it is on the line, not of it. */
export function InflowDot({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={3.5} className="fill-[#4f8a5c] dark:fill-[#7fb886]" />
}

/** Everything past the lane cap, drawn as a stack of stubs rather than a lane each. */
function BundleStubs({ at }: { at: number }) {
  return (
    <>
      <line x1={STUB_X[0]} y1={at + 14} x2={STUB_X[0]} y2={at - 14} className={LANE_STROKE.loose} strokeWidth={2} strokeOpacity={0.55} />
      <line x1={STUB_X[1]} y1={at + 14} x2={STUB_X[1]} y2={at - 10} className={LANE_STROKE.loose} strokeWidth={2} strokeOpacity={0.4} />
      <line x1={STUB_X[2]} y1={at + 14} x2={STUB_X[2]} y2={at - 6} className={LANE_STROKE.loose} strokeWidth={2} strokeOpacity={0.25} />
    </>
  )
}

/** Filled = local-only, hollow = on GitHub, dashed hollow = remote state unknown. */
function CommitDot({ y, onGitHub, merge }: { y: number; onGitHub: boolean | null; merge: boolean }) {
  if (onGitHub === null) {
    return (
      <circle
        cx={MAIN_X}
        cy={y}
        r={4.5}
        className="fill-bg stroke-text-muted"
        strokeOpacity={0.65}
        strokeWidth={2}
        strokeDasharray="2 2"
      />
    )
  }
  if (onGitHub) {
    return (
      <circle cx={MAIN_X} cy={y} r={4.5} className="fill-bg stroke-text-muted" strokeOpacity={0.6} strokeWidth={2} />
    )
  }
  return (
    <>
      <circle cx={MAIN_X} cy={y} r={merge ? 5.5 : 5} className="fill-accent" />
      {merge && <circle cx={MAIN_X} cy={y} r={2} className="fill-bg" />}
    </>
  )
}
