// Formatting shared by the Usage surfaces (the provider cards and the history chart). Extracted so the
// same dollar, token, model, and date wording appears in both instead of drifting apart.

/** USD with cents — small amounts still read as a number, not "$0". */
export function fmtUsd(n: number): string {
  const abs = Math.abs(n)
  return `${n < 0 ? '-' : ''}$${abs.toFixed(abs < 1 ? 4 : 2)}`
}

/** Compact token count: 1.2K / 3.4M. */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

/**
 * Engine model id → a friendly label for non-engineers, derived generically (never a hardcoded
 * lookup — the no-model-names rule). `claude-opus-4-8[1m]` → "Opus 4.8 · 1M context";
 * `claude-haiku-4-5-20251001` → "Haiku 4.5". Falls back to the raw id if it doesn't parse.
 */
export function prettyModel(id: string): string {
  const ctx = /\[(\d+)m\]$/i.exec(id)?.[1]
  const stripped = id
    .replace(/^claude-/, '')
    .replace(/\[\d+m\]$/i, '')
    .replace(/-\d{6,}$/, '') // trailing date stamp
  const [family, ...rest] = stripped.split('-')
  if (!family) return id
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const label = rest.length ? `${cap(family)} ${rest.join('.')}` : cap(family)
  return ctx ? `${label} · ${ctx}M context` : label
}

/** Local `YYYY-MM-DD` → "Today" / "Yesterday" / "Mon, Jun 23". */
export function fmtDay(date: string): string {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date()
  if (date === iso(today)) return 'Today'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date === iso(yesterday)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** Short axis form for a chart tick: "Jun 23". */
export function fmtDayShort(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
