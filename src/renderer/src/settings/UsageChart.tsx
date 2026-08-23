import { useState } from 'react'
import type { DailyPoint } from '@shared/usage-value'
import { motion, spring, useReducedMotion } from '../motion'
import { engineAccent, engineOrder, engineShort } from '../workspace/models'
import { SegmentedControl } from './controls'
import { fmtDay, fmtDayShort, fmtHour, fmtTokens, fmtUsd } from './usage-format'

function countLabel(n: number, noun: 'turns' | 'responses'): string {
  return n === 1 ? `1 ${noun.slice(0, -1)}` : `${n} ${noun}`
}

/**
 * Daily usage as columns, cross-engine, with one toggle: dollars or tokens. Both are the same measured
 * facts read two ways — cost is what the engine billed the turn, tokens are what it counted — so the
 * toggle changes the unit, never the source. Nothing here is a trend line or a projection.
 *
 * Marks follow the house chart spec: thin columns capped in width, a 4px rounded cap over a square
 * baseline, a 2px surface gap between stacked engine segments (the gap does the separating, not a
 * stroke), hairline baseline, and text in text tokens so a colored segment beside a label carries the
 * identity instead of the type. A legend appears once two engines have run; one engine needs none,
 * because the heading already says whose it is.
 */

export type UsageChartMode = 'cost' | 'tokens'

const CHART_HEIGHT = 96
/** Enough of a stub that an active-but-tiny day is visibly not zero. */
const MIN_VISIBLE_PX = 2

export function UsageChart({
  daily,
  engines,
  resolution = 'day',
  countNoun = 'turns',
}: {
  daily: DailyPoint[]
  engines: string[]
  /** 'hour' renders the same columns over ISO hour-start dates (the rolling-24h Usage view). */
  resolution?: 'day' | 'hour'
  /** What a point's `turns` count actually counts — the scan view plots responses, not turns. */
  countNoun?: 'turns' | 'responses'
}) {
  const [mode, setMode] = useState<UsageChartMode>('cost')
  const [hover, setHover] = useState<string | null>(null)
  const reduce = useReducedMotion()
  const labelLong = (date: string): string => (resolution === 'hour' ? fmtHour(date) : fmtDay(date))
  const labelShort = (date: string): string =>
    resolution === 'hour' ? fmtHour(date) : fmtDayShort(date)

  // Cost mode plots PRICED cost. An engine that reports a cost estimate for models with no published
  // rate contributes tokens here and nothing to the dollar view — the same tokens-only contract the
  // provider cards hold, so the two surfaces can never disagree about who gets a dollar sign.
  const valueOf = (d: DailyPoint): number => (mode === 'cost' ? d.pricedCostUsd : d.totalTokens)
  const fmt = (n: number): string => (mode === 'cost' ? fmtUsd(n) : `${fmtTokens(n)} tokens`)
  const peak = Math.max(...daily.map(valueOf), 0)
  const peakDay = daily.find((d) => valueOf(d) === peak && peak > 0)
  const ordered = [...engines].sort((a, b) => engineOrder(a) - engineOrder(b))
  const multi = ordered.length > 1

  return (
    <div className="py-3">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-text">
            {mode === 'cost' ? 'Cost' : 'Tokens'} per {resolution}
          </div>
          {peakDay && (
            <div className="mt-0.5 text-[12.5px] text-text-muted">
              Busiest {resolution} {labelLong(peakDay.date)}, {fmt(peak)}
            </div>
          )}
        </div>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          ariaLabel="Chart unit"
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'tokens', label: 'Tokens' },
          ]}
        />
      </div>

      <div className="relative">
        <div className="flex items-end gap-[3px]" style={{ height: CHART_HEIGHT }}>
          {daily.map((d) => {
            const total = valueOf(d)
            const px = peak > 0 && total > 0 ? Math.max(MIN_VISIBLE_PX, (total / peak) * CHART_HEIGHT) : 0
            const segments = ordered
              .map((engineId) => {
                const e = d.byEngine.find((x) => x.engineId === engineId)
                return { engineId, value: e ? (mode === 'cost' ? e.pricedCostUsd : e.totalTokens) : 0 }
              })
              .filter((s) => s.value > 0)
            // Segment heights divide the split's OWN total so the stack always fills the column — a
            // legacy day recorded before engine tagging has no split to draw and falls back to one fill.
            const splitTotal = segments.reduce((sum, s) => sum + s.value, 0)
            return (
              <div
                key={d.date}
                className="group relative flex h-full max-w-[24px] flex-1 flex-col justify-end"
                onMouseEnter={() => setHover(d.date)}
                onMouseLeave={() => setHover((cur) => (cur === d.date ? null : cur))}
                tabIndex={0}
                onFocus={() => setHover(d.date)}
                onBlur={() => setHover((cur) => (cur === d.date ? null : cur))}
                role="img"
                aria-label={`${labelLong(d.date)}: ${fmt(total)}, ${countLabel(d.turns, countNoun)}`}
              >
                <motion.div
                  className="flex w-full flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                  animate={{ height: px }}
                  initial={false}
                  transition={reduce ? { duration: 0 } : spring.snappy}
                >
                  {splitTotal > 0 ? (
                    segments.map((s) => (
                      <div
                        key={s.engineId}
                        className={engineAccent(s.engineId)}
                        style={{ height: `${(s.value / splitTotal) * 100}%` }}
                      />
                    ))
                  ) : (
                    <div className="h-full w-full bg-accent/70" />
                  )}
                </motion.div>
              </div>
            )
          })}
        </div>
        <div className="mt-1 h-px w-full bg-border" />
        <div className="mt-1.5 flex justify-between text-[11px] text-text-muted">
          <span>{daily[0] && labelShort(daily[0].date)}</span>
          <span>{daily.length > 1 && labelLong(daily[daily.length - 1].date)}</span>
        </div>

        {hover && (
          <ChartTooltip
            point={daily.find((d) => d.date === hover)}
            mode={mode}
            label={labelLong}
            countNoun={countNoun}
          />
        )}
      </div>

      {multi && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          {ordered.map((engineId) => (
            <span key={engineId} className="flex items-center gap-1.5 text-[12px] text-text-muted">
              <span className={`h-2 w-2 rounded-[2px] ${engineAccent(engineId)}`} />
              {engineShort(engineId)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** The hovered day's exact numbers. Anchored above the column strip rather than the column so it can
 *  never push the card wider or get clipped at either end of the window. */
function ChartTooltip({
  point,
  mode,
  label,
  countNoun,
}: {
  point?: DailyPoint
  mode: UsageChartMode
  label: (date: string) => string
  countNoun: 'turns' | 'responses'
}) {
  if (!point) return null
  const value = mode === 'cost' ? point.pricedCostUsd : point.totalTokens
  const fmt = (n: number): string => (mode === 'cost' ? fmtUsd(n) : fmtTokens(n))
  const split = [...point.byEngine]
    .filter((e) => (mode === 'cost' ? e.pricedCostUsd : e.totalTokens) > 0)
    .sort((a, b) => engineOrder(a.engineId) - engineOrder(b.engineId))
  return (
    <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 shadow-pop">
      <div className="text-[12px] font-medium text-text">{label(point.date)}</div>
      <div className="mt-0.5 font-mono text-[12px] text-text">{fmt(value)}</div>
      {split.length > 1 &&
        split.map((e) => (
          <div key={e.engineId} className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`h-2 w-2 rounded-[2px] ${engineAccent(e.engineId)}`} />
            {engineShort(e.engineId)} {fmt(mode === 'cost' ? e.pricedCostUsd : e.totalTokens)}
          </div>
        ))}
      <div className="mt-0.5 text-[11px] text-text-muted">{countLabel(point.turns, countNoun)}</div>
    </div>
  )
}
