import { useEffect, useMemo, useState } from 'react'
import type { UsageScanSummary } from '@shared/ipc'
import { buildScanUsageValue, type ScanUsageValue } from '@shared/usage-value'
import { engineAccent, engineShort } from '../workspace/models'
import { SegmentedControl, SettingsSection } from './controls'
import { UsageChart } from './UsageChart'
import { fmtTokens, fmtUsd, prettyModel } from './usage-format'

/**
 * Settings → Usage: the whole subscription's accounting, built ONLY on the transcript scan
 * (usage-scan.ts) priced with citable provenance (usage-pricing.ts). This page deliberately covers
 * activity inside AND outside Koda; the per-engine plan windows stay in AI providers, because
 * limits are the provider's live word and this page is the ledger.
 *
 * Load-once: everything renders from one IPC answer, and the skeleton holds until it lands whole,
 * so no number on the page ever jumps as sources trickle in. Every figure is measured-fact
 * arithmetic from `buildScanUsageValue`; the reconciliation tests live beside that builder.
 */

type WindowKey = '24h' | '7d' | '30d' | '90d'
const WINDOW_DAYS: Record<WindowKey, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }

/** Local YYYY-MM-DD for `daysAgo` calendar days back — same wall-clock keying the scanner uses. */
function localDayAgo(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function UsageSection() {
  const [summary, setSummary] = useState<UsageScanSummary | null>(null)
  const [failed, setFailed] = useState(false)
  const [window_, setWindow] = useState<WindowKey>('30d')
  const [breakdown, setBreakdown] = useState<'model' | 'day'>('model')

  useEffect(() => {
    let live = true
    window.koda
      .getUsageScanSummary()
      .then((s) => live && setSummary(s))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  const value = useMemo(() => {
    if (!summary) return null
    if (window_ === '24h') {
      const since = Date.now() - 24 * 60 * 60 * 1000
      return buildScanUsageValue(summary.buckets.filter((b) => b.hourStartMs >= since))
    }
    const sinceDay = localDayAgo(WINDOW_DAYS[window_] - 1)
    return buildScanUsageValue(summary.buckets.filter((b) => b.day >= sinceDay))
  }, [summary, window_])

  return (
    <>
      <SettingsSection
        title="Usage"
        note="Counting all Claude Code and Codex activity on this Mac, inside and outside Koda. Every figure is measured; nothing is a prediction."
        action={
          <SegmentedControl
            value={window_}
            onChange={setWindow}
            ariaLabel="Usage window"
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7 days' },
              { value: '30d', label: '30 days' },
              { value: '90d', label: '90 days' },
            ]}
          />
        }
      >
        {failed ? (
          <p className="py-4 text-[12.5px] text-text-muted">
            Usage couldn’t be read just now. Reopen this screen to try again.
          </p>
        ) : !value || !summary ? (
          <UsageSkeleton />
        ) : (
          <>
            <Hero value={value} />
            <UsageChart
              daily={window_ === '24h' ? value.hourly : value.daily}
              engines={value.byEngine.map((e) => e.engineId)}
              resolution={window_ === '24h' ? 'hour' : 'day'}
              countNoun="responses"
            />
            <MetricsStrip value={value} window={window_} />
          </>
        )}
      </SettingsSection>

      {value && summary && (
        <SettingsSection
          title="Breakdown"
          action={
            <SegmentedControl
              value={breakdown}
              onChange={setBreakdown}
              ariaLabel="Breakdown grouping"
              options={[
                { value: 'model', label: 'By model' },
                { value: 'day', label: 'By day' },
              ]}
            />
          }
        >
          {breakdown === 'model' ? <ModelTable value={value} /> : <DayTable value={value} />}
          <OriginLine value={value} />
          <CoverageFooter summary={summary} />
        </SettingsSection>
      )}
    </>
  )
}

/** The financial answer first: what the window's tokens are worth at full API rates, the cache's
 *  discount beside it, then how that value splits across the providers. Exported (with the strip
 *  and table below) so the citable-dollar invariant is asserted in the ordinary Node test lane. */
export function Hero({ value }: { value: ScanUsageValue }) {
  const saved = value.cacheSavingsUsd
  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-4 py-4">
      <div className="min-w-[13rem]">
        <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
          Raw token cost
        </div>
        <div className="mt-1 font-mono text-[30px] font-semibold leading-none text-text" data-testid="usage-headline">
          {fmtUsd(value.pricedCostUsd)}
          <span className="text-[16px] font-normal text-text-muted">*</span>
        </div>
        <div className="mt-1.5 text-[12px] text-text-muted">* if billed at full API rate</div>
        {saved != null && saved !== 0 && (
          <div className="mt-3 text-[12.5px] text-text-muted">
            {saved > 0 ? 'Cache reuse saved ' : 'Cache writes added '}
            <span className="font-mono text-text">{fmtUsd(Math.abs(saved))}</span>
            {value.pricedCostUsd > 0 && saved > 0 && (
              <span className="block text-[11.5px]">
                {(saved / value.pricedCostUsd).toFixed(1)}× the raw cost, against full input rates
              </span>
            )}
          </div>
        )}
      </div>
      <div className="min-w-[14rem] flex-1 space-y-3.5 pt-1">
        {value.byEngine.map((e) => (
          <div key={e.engineId}>
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="flex items-center gap-2 text-text">
                <span className={`h-2 w-2 rounded-[2px] ${engineAccent(e.engineId)}`} />
                {engineShort(e.engineId)}
              </span>
              <span className="font-mono text-text">
                {e.pricedCostUsd > 0 ? fmtUsd(e.pricedCostUsd) : `${fmtTokens(e.totalTokens)} tokens`}
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-border/60">
              <div
                className={`h-full rounded-full ${engineAccent(e.engineId)}`}
                style={{ width: `${Math.max(2, (e.pricedCostUsd > 0 ? e.costShare : e.tokenShare) * 100)}%` }}
              />
            </div>
            <div className="mt-1 text-[11.5px] text-text-muted">
              {e.pricedCostUsd > 0
                ? `${Math.round(e.costShare * 100)}% of cost · ${fmtTokens(e.totalTokens)} tokens`
                : `${Math.round(e.tokenShare * 100)}% of tokens`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MetricsStrip({ value, window: win }: { value: ScanUsageValue; window: WindowKey }) {
  const perLabel = win === '24h' ? 'in the last day' : 'per active day'
  const observedInput = value.inputTokens + value.cacheReadTokens
  const tiles: { label: string; value: string; detail: string }[] = [
    {
      label: 'Processed tokens',
      value: fmtTokens(value.totalTokens),
      detail: win === '24h' ? `${value.records} responses` : `${fmtTokens(value.tokensPerActiveDay)} ${perLabel}`,
    },
    {
      label: 'Cached input',
      value: fmtTokens(value.cacheReadTokens),
      detail: observedInput > 0 ? `${Math.round((value.cacheReadTokens / observedInput) * 100)}% of observed input` : '—',
    },
    {
      label: 'Uncached input',
      value: fmtTokens(value.inputTokens),
      detail: `${fmtTokens(value.cacheCreationTokens)} cache writes`,
    },
    {
      label: 'Output',
      value: fmtTokens(value.outputTokens),
      detail: `incl. ${fmtTokens(value.reasoningTokens)} reasoning`,
    },
    {
      label: 'Cache savings',
      // A dollar only with a citation; no citable rate ⇒ an honest dash, never a guessed figure.
      value: value.cacheSavingsUsd != null ? fmtUsd(value.cacheSavingsUsd) : '—',
      detail:
        value.cacheSavingsUsd != null
          ? value.pricedCostUsd > 0
            ? `${(value.cacheSavingsUsd / value.pricedCostUsd).toFixed(1)}× the raw cost`
            : 'vs full input rates'
          : 'no citable rate',
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-px border-y border-border bg-border/60 md:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className="bg-bg px-3 py-2.5">
          <div className="text-[11px] text-text-muted">{t.label}</div>
          <div className="mt-0.5 font-mono text-[15px] text-text">{t.value}</div>
          <div className="mt-0.5 text-[10.5px] text-text-muted">{t.detail}</div>
        </div>
      ))}
    </div>
  )
}

export function ModelTable({ value }: { value: ScanUsageValue }) {
  if (value.models.length === 0)
    return <p className="py-4 text-[12.5px] text-text-muted">No activity in this window.</p>
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-border text-left text-[11.5px] text-text-muted">
          <th className="py-1.5 font-normal">Model</th>
          <th className="py-1.5 text-right font-normal">Cost</th>
          <th className="py-1.5 text-right font-normal">Share</th>
          <th className="py-1.5 text-right font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {value.models.map((m) => (
          <tr key={`${m.engine}:${m.model}`} className="border-b border-border/50 last:border-b-0">
            <td className="py-2 text-text">
              <span className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-[2px] ${engineAccent(m.engine)}`} />
                {prettyModel(m.model)}
              </span>
            </td>
            {m.costUsd != null ? (
              <>
                <td className="py-2 text-right font-mono text-text">{fmtUsd(m.costUsd)}</td>
                <td className="py-2 text-right font-mono text-text-muted">
                  {Math.round(m.costShare * 100)}%
                </td>
              </>
            ) : (
              <td colSpan={2} className="py-2 text-right text-[12px] text-text-muted">
                no citable rate · tokens only
              </td>
            )}
            <td className="py-2 text-right font-mono text-text-muted">{fmtTokens(m.totalTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DayTable({ value }: { value: ScanUsageValue }) {
  const rows = [...value.daily].reverse()
  if (rows.length === 0)
    return <p className="py-4 text-[12.5px] text-text-muted">No activity in this window.</p>
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-border text-left text-[11.5px] text-text-muted">
          <th className="py-1.5 font-normal">Day</th>
          <th className="py-1.5 text-right font-normal">Cost</th>
          <th className="py-1.5 text-right font-normal">Tokens</th>
          <th className="py-1.5 text-right font-normal">Responses</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.date} className="border-b border-border/50 last:border-b-0">
            <td className="py-2 text-text">{d.date}</td>
            <td className="py-2 text-right font-mono text-text">{fmtUsd(d.pricedCostUsd)}</td>
            <td className="py-2 text-right font-mono text-text-muted">{fmtTokens(d.totalTokens)}</td>
            <td className="py-2 text-right font-mono text-text-muted">{d.turns}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OriginLine({ value }: { value: ScanUsageValue }) {
  const total = value.originTokens.koda + value.originTokens.outside
  if (total === 0) return null
  const koda = Math.round((value.originTokens.koda / total) * 100)
  return (
    <p className="mt-3 text-[12px] text-text-muted">
      {koda >= 100
        ? 'All of this ran through Koda.'
        : koda <= 0
          ? 'All of this ran outside Koda, in the terminal and other tools.'
          : `${koda}% of this ran through Koda · ${100 - koda}% in the terminal and other tools.`}
    </p>
  )
}

/** Plain sentences for anything short of full coverage, plus where the rates came from — the page
 *  never lets a partial scan or an aged price table read as certainty. */
function CoverageFooter({ summary }: { summary: UsageScanSummary }) {
  const partial = summary.sources.filter((s) => s.status === 'partial')
  const p = summary.provenance
  const fetched = p.fetchedAt != null ? new Date(p.fetchedAt).toLocaleDateString() : null
  return (
    <div className="mt-4 border-t border-border pt-3 text-[12px] text-text-muted">
      {partial.map((s) => (
        <p key={s.root}>
          Some {engineShort(s.engine)} history couldn’t be read ({s.skippedFiles}{' '}
          {s.skippedFiles === 1 ? 'file' : 'files'} skipped). Showing what’s visible.
        </p>
      ))}
      <p>
        {p.status === 'fresh' && `Rates: LiteLLM price table, fetched ${fetched}.`}
        {p.status === 'cached' && `Rates: LiteLLM price table from ${fetched}; the refresh didn’t reach the network.`}
        {p.status === 'unavailable' && 'Rates: Koda’s built-in table only; the public price list wasn’t reachable.'}
      </p>
    </div>
  )
}

/** Static stand-in with the loaded page's shape; blocks fill in exactly once when the scan answers. */
function UsageSkeleton() {
  return (
    <div className="animate-pulse py-4" aria-label="Loading usage">
      <div className="h-8 w-36 rounded-md bg-border/60" />
      <div className="mt-2 h-3 w-28 rounded bg-border/50" />
      <div className="mt-6 flex items-end gap-1" style={{ height: 96 }}>
        {[34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67].map((h) => (
          <div key={h} className="flex-1 rounded-t-[4px] bg-border/50" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-px border-y border-border bg-border/60 md:grid-cols-5">
        {['a', 'b', 'c', 'd', 'e'].map((k) => (
          <div key={k} className="bg-bg px-3 py-2.5">
            <div className="h-3 w-16 rounded bg-border/50" />
            <div className="mt-1.5 h-4 w-12 rounded bg-border/60" />
          </div>
        ))}
      </div>
    </div>
  )
}
