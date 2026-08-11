/**
 * Which conversation a mini app's face turn lands in.
 *
 * A face turn never goes to whichever chat happens to be active — that dropped an app question into
 * the middle of an unrelated conversation (dogfood 07-30). It goes to the app's OWN summon thread,
 * remembered per app dir. With `settings.appDaySessions` on (the default), that thread is scoped to
 * the local calendar day: a day of logging is one dated conversation, and a month of it is a month of
 * dated conversations you can look back through rather than one endless thread every turn re-reads.
 *
 * Both heads — the desktop renderer and the phone shell — run this, each against its own
 * localStorage. They never see each other's map, so the LABEL is the cross-head identity: whichever
 * head speaks first names the day's thread, and the other recognises it by that exact string in the
 * running/history lists instead of opening a second one. That makes `faceDayLabel` a contract, which
 * is why it can't use toLocaleDateString — its output moves with locale, and a WKWebView and an
 * Electron renderer don't share one.
 */

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day thread's title, e.g. `Health & Fitness · Tue, Aug 5`. Applied as a user rename, so the
 *  first-prompt auto-titler can't rename the day to whatever got logged that morning. */
export function faceDayLabel(appName: string, d: Date): string {
  return `${appName} · ${DAY_SHORT[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`
}

/** The local calendar day a face turn belongs to — midnight local, the boundary a person means by
 *  "today". Keys the thread map; never shown. */
export function faceDayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One app's remembered thread. `day` absent = an unstamped thread (day sessions off, or an entry
 *  written before they existed). */
export type SummonEntry = { id: string; day?: string }

/** Where the map lives — the same key on both heads, so the shapes must stay compatible. */
export const APP_SUMMON_KEY = 'koda.appSummonThreads'

/** The minimum of `Storage` this needs — passed in so it's testable off a browser. */
export type ThreadStore = Pick<Storage, 'getItem' | 'setItem'>

function readSummonMap(store: ThreadStore): Record<string, SummonEntry> {
  try {
    const raw = JSON.parse(store.getItem(APP_SUMMON_KEY) ?? '{}') as Record<string, unknown>
    const out: Record<string, SummonEntry> = {}
    for (const [dir, v] of Object.entries(raw)) {
      // Entries written before day threads were a bare session id — read as an unstamped thread.
      if (typeof v === 'string') out[dir] = { id: v }
      else if (v && typeof v === 'object' && typeof (v as SummonEntry).id === 'string')
        out[dir] = v as SummonEntry
    }
    return out
  } catch {
    return {} // private mode / corrupt value — the map is a nicety, never fatal
  }
}

/** The thread this app's turns should join, or null to open one. `day` null = forever-thread mode
 *  (setting off), where any remembered thread qualifies; otherwise only one stamped with the SAME
 *  local day does, so yesterday's thread is never mistaken for today's. */
export function appSummonThread(store: ThreadStore, dir: string, day: string | null): string | null {
  const entry = readSummonMap(store)[dir]
  if (!entry) return null
  if (day && entry.day !== day) return null
  return entry.id
}

export function rememberAppSummonThread(
  store: ThreadStore,
  dir: string,
  sessionId: string,
  day: string | null,
): void {
  try {
    const map = readSummonMap(store)
    map[dir] = day ? { id: sessionId, day } : { id: sessionId }
    store.setItem(APP_SUMMON_KEY, JSON.stringify(map))
  } catch {
    /* quota — the map is a nicety, never fatal */
  }
}
