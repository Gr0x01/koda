/**
 * The Library's retrieval seam: `searchLibrary(question) → refs`, across BOTH of the project's
 * corpora — the documents the user wrote, and the conversations Koda was present for.
 *
 * ── Why this shape, and what may change behind it ────────────────────────────────────────────────
 *
 * `.koda/memory/memory-system.md` (§3) settled retrieval for this project before it was built, and the
 * commitment is worth restating because it is what this file is: Claude Code removed its own vector
 * database in favour of file-first agentic search, Koda adopted the reasoning (privacy, staleness,
 * reliability, simplicity), and markdown stays canonical permanently — any index is a derived,
 * rebuildable projection of it. The committed ladder is **grep now** (good to roughly 1k files), SQLite
 * FTS5 at 1k–10k, local-only vector past that, and a hosted embedding API is named as the single choice
 * that would break "nothing leaves your machine." Koda's own project holds 54 documents, an order of
 * magnitude below the first rung, so this is the grep rung: no index, no embeddings, no dependency.
 *
 * The same note pre-committed the escape hatch — "retrieval behind a small `search(query) → file refs`
 * seam in the main process (grep today, FTS5 tomorrow, local vector maybe-never — without touching the
 * renderer or the files)". So the contract here is deliberately narrow: **`searchLibrary` and
 * `LibraryRef` are the seam.** Climbing a rung replaces `splitTerms` and the two scanners below and
 * nothing else; `library-ask.ts` and every later caller are untouched. A caller that reaches past this
 * function into `queryLibrary` or the session store has re-forked retrieval and the ladder stops working.
 *
 * The tripwire for that, also recorded in CLAUDE.md's checks:
 *
 *     rg -n "listHotSessions" src shared --glob '!**\/session-store.ts' --glob '!**\/*.test.ts'
 *     rg -n "loadArchivedBody\(" src --glob '!**\/session-store.ts' --glob '!**\/*.test.ts'
 *
 * The first must match only this file. The second must match only this file and the archive-restore
 * handler in `ipc.ts`, which pulls one body back into a transcript and is not retrieval.
 *
 * ── Why retrieval is Koda's job rather than the agent's ──────────────────────────────────────────
 *
 * "Agentic grep" normally means handing the model Grep and letting it hunt. That cannot work here, for
 * a reason specific to the differentiating half of this feature: **conversations do not live in the
 * project.** They live in Koda's own store under `userData`, outside the project root every tool in the
 * product is contained to. An agent with Grep can search the documents (which Notion and Obsidian
 * already do) and structurally cannot search the sessions (which is the part nobody else has). So the
 * walk happens here, and the engine is handed what was found.
 */
import type { EngineId, LibraryAskScope } from '@shared/ipc'
import { isEngineId } from '@shared/engine-capabilities'
import { queryLibrary } from './fs-browse'
import {
  listHotSessions,
  loadArchivedBodyForSearch,
  loadArchivedMeta,
  readEngineConversationReplayDetailed,
} from './session-store'

/** One quoted span backing a reference — a document line, or one turn of a conversation. */
export interface LibraryPassage {
  /** 1-based line, for a document. A conversation turn has no line number and leaves this absent. */
  line?: number
  text: string
}

/**
 * One thing the question matched. The `id` is the load-bearing field: it is the ONLY handle the engine
 * is given, so an answer can only ever cite something retrieval actually found. A path or a session id
 * the engine invented has nowhere to land.
 */
export interface LibraryRef {
  /** Stable within one search: `d1`, `d2`, `s1`… Documents are `d`, conversations are `s`. */
  id: string
  kind: 'document' | 'session'
  /** What a citation chip reads. A document's authored title (else its filename); a session's label. */
  label: string
  /** Documents only: the absolute path the chip opens, and the project-relative breadcrumb. */
  path?: string
  rel?: string
  /** Conversations only. `archived` is carried so the ask never has to guess where a body came from. */
  sessionId?: string
  archived?: boolean
  passages: LibraryPassage[]
  /** How many distinct query terms this ref matched in its CONTENT — the primary ranking signal. */
  termsMatched: number
  score: number
  /** Epoch ms of last activity, the recency tiebreak. 0 when the corpus has no timestamp to offer. */
  updatedAt: number
}

export interface LibrarySearchResult {
  /** The content words the question was reduced to. Empty ⇒ the question was all stopwords. */
  terms: string[]
  /** Best first. */
  refs: LibraryRef[]
  /** A corpus was not fully WALKED — the documents universe hit its own cap, an archive index could
   *  not be read, or there were more archived conversations than the scan opens. Not set merely because
   *  ranking cut the list to `limit`; see `searchLibrary`. */
  truncated: boolean
}

export interface LibrarySearchOptions {
  /** Which corpora to walk. Default `'all'`. */
  scope?: LibraryAskScope
  /** Max refs returned. Default (and ceiling) `LIMITS.maxRefs`. */
  limit?: number
  /** Whether the acknowledged hot-session snapshot is still current when the session scan begins. */
  hotSessionsComplete?: boolean | (() => boolean)
}

/** Bounds. An ask is deliberate and rare, so these are generous compared with the Find overlay's — but
 *  they exist because a dogfood project's archive is ~50MB across ~170 conversations, and neither the
 *  walk nor the prompt built from it may grow with the store. */
const LIMITS = {
  /** Content words carried into the walk. Each one costs a full documents pass, so this is the knob
   *  that decides retrieval cost; a longer question gets its longest, most distinctive words. */
  maxTerms: 6,
  /** Refs handed back (and therefore offered to the engine as citable). */
  maxRefs: 12,
  /** Quoted spans per ref — enough to show the claim rests on more than one line, few enough that one
   *  chatty conversation cannot crowd out every other source. */
  maxPassages: 3,
  /** Chars per quoted span, windowed around the first match like the Find overlay's previews. */
  maxPassageChars: 320,
  previewLead: 60,
  /** Archived conversations opened, newest first. Past this the walk reports itself truncated rather
   *  than parsing an unbounded pile of transcript bodies for one question. */
  maxArchivesScanned: 120,
  /** Hot rows inspected, already persisted newest-first. Open chats can also grow without bound. */
  maxHotSessionsScanned: 120,
  /** One cold body/replay sidecar and all cold bytes parsed for a single ask. */
  maxArchiveBytesPerSession: 2_000_000,
  maxArchiveBytesTotal: 20_000_000,
  /** Turns read from any single conversation, newest first — a months-long thread must not dominate. */
  maxTurnsPerSession: 1200,
  /** Chars of any single turn considered. Long pasted blobs are evidence of a paste, not of a decision. */
  maxTurnChars: 4000,
} as const

/**
 * English stopword floor. Deliberately tiny and closed: this exists so "What did we decide about phone
 * tiers?" searches for `decide phone tiers` instead of matching every file containing "about", not to
 * be a linguistics layer.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before',
  'being', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'done', 'for', 'from', 'get', 'got',
  'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'own', 'she',
  'should', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

/**
 * A question → the content words to search for. Exported because it is the half of this seam most
 * likely to be replaced first (FTS5 brings its own tokenizer and its own stemming), and because the
 * ranking below is only explainable if the terms are.
 */
export function splitTerms(question: string): string[] {
  return splitTermsDetailed(question).terms
}

function splitTermsDetailed(question: string): { terms: string[]; truncated: boolean } {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const kept: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    if (STOPWORDS.has(w) || seen.has(w)) continue
    seen.add(w)
    kept.push(w)
  }
  // Two characters is the floor, not three. This audience's vocabulary is full of real two-letter
  // terms — ui, js, db, ai — and dropping them turns "what did we decide about the ui" into a search
  // for "decide". A noisy short term costs little because ranking is dominated by how MANY distinct
  // terms a source matched, so a file that only contains "ui" inside "building" lands below one that
  // answers the whole question. Single characters are dropped unless nothing else survives.
  const substantial = kept.filter((w) => w.length >= 2)
  const pool = substantial.length ? substantial : kept
  // Longest first when the cap bites: "tiers" discriminates and "did" does not, and a question long
  // enough to trip the cap is exactly the one where the weak words are noise.
  const ranked = [...pool].sort((a, b) => b.length - a.length)
  return { terms: ranked.slice(0, LIMITS.maxTerms), truncated: ranked.length > LIMITS.maxTerms }
}

/**
 * Search both corpora for a question. Never throws: a corpus that cannot be read contributes nothing
 * and marks the result truncated, because a partial answer with a caveat beats no answer at all — and
 * because a read-only search must never be the thing that decides a user's store is broken.
 */
export async function searchLibrary(
  root: string,
  question: string,
  opts: LibrarySearchOptions = {},
): Promise<LibrarySearchResult> {
  const termResult = splitTermsDetailed(question)
  const terms = termResult.terms
  const scope = opts.scope ?? 'all'
  const limit = Math.max(1, Math.min(opts.limit ?? LIMITS.maxRefs, LIMITS.maxRefs))
  if (!terms.length) return { terms, refs: [], truncated: false }

  const found: RawRef[] = []
  let truncated = termResult.truncated

  if (scope !== 'sessions') {
    const docs = await scanDocuments(root, terms)
    found.push(...docs.refs)
    truncated = truncated || docs.truncated
  }
  if (scope !== 'documents') {
    const hotSessionsComplete =
      typeof opts.hotSessionsComplete === 'function'
        ? opts.hotSessionsComplete()
        : (opts.hotSessionsComplete ?? true)
    const sessions = scanSessions(root, terms, hotSessionsComplete)
    found.push(...sessions.refs)
    truncated = truncated || sessions.truncated
  }

  found.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
  // An omitted source can hold the qualifying fact even when ranking preferred another one. The
  // answer may still be useful, but it is partial and has to say so.
  if (found.length > limit) truncated = true

  // Ids are assigned AFTER ranking so `d1`/`s1` read in the order the engine sees them.
  let docN = 0
  let sessionN = 0
  const refs = found.slice(0, limit).map<LibraryRef>((r) => ({
    ...r,
    id: r.kind === 'document' ? `d${++docN}` : `s${++sessionN}`,
  }))
  return { terms, refs, truncated }
}

/** A ref before it has been ranked and given its citable id. */
type RawRef = Omit<LibraryRef, 'id'>

// ── Corpus 1: the user's documents ────────────────────────────────────────────
//
// Straight through `queryLibrary`, one pass per term. That is more file reads than a bespoke walk
// would need, and it is the right trade: `queryLibrary` owns the ONE reconciliation of the doc walk's
// exclusion set with the search walk's, so a document found by an ask is found by exactly the rules
// that decide what the Library lists and what the Find overlay matches. A second walk here would be a
// second copy of those rules, free to drift, and the drift would show up as an answer citing
// `CLAUDE.md` or a vendored skill file at the one user this feature exists for.

async function scanDocuments(root: string, terms: string[]): Promise<{ refs: RawRef[]; truncated: boolean }> {
  const byPath = new Map<string, DocAccumulator>()
  let truncated = false

  for (const term of terms) {
    let result: Awaited<ReturnType<typeof queryLibrary>>
    try {
      result = await queryLibrary(root, { query: term })
    } catch {
      truncated = true // the walk failed for this term; the others still stand
      continue
    }
    truncated = truncated || result.truncated
    for (const doc of result.docs) {
      const acc =
        byPath.get(doc.path) ??
        ({
          label: doc.title?.trim() || doc.name,
          path: doc.path,
          rel: doc.rel,
          updatedAt: doc.mtimeMs,
          contentTerms: new Set<string>(),
          nameTerms: new Set<string>(),
          passages: new Map<number, string>(),
        } satisfies DocAccumulator)
      byPath.set(doc.path, acc)
      if (doc.matches.length) acc.contentTerms.add(term)
      if (doc.nameMatch) acc.nameTerms.add(term)
      // Keyed by line so two terms hitting the same line quote it once.
      for (const m of doc.matches) if (!acc.passages.has(m.line)) acc.passages.set(m.line, m.preview)
    }
  }

  const refs: RawRef[] = []
  for (const acc of byPath.values()) {
    // A title-only hit counts only when the title answered the WHOLE question. `queryLibrary` matches
    // filenames by fuzzy subsequence, so one loose term against a long filename is close to noise;
    // "Phone tiers" against `phone tiers` is not.
    if (!acc.contentTerms.size && acc.nameTerms.size < terms.length) continue
    const passages = [...acc.passages.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, LIMITS.maxPassages)
      .map(([line, text]) => ({ line, text: clip(text) }))
    if (acc.passages.size > LIMITS.maxPassages) truncated = true
    refs.push({
      kind: 'document',
      label: acc.label,
      path: acc.path,
      rel: acc.rel,
      passages,
      termsMatched: acc.contentTerms.size,
      score: rank(acc.contentTerms.size, acc.nameTerms.size, acc.passages.size),
      updatedAt: acc.updatedAt,
    })
  }
  return { refs, truncated }
}

interface DocAccumulator {
  label: string
  path: string
  rel: string
  updatedAt: number
  contentTerms: Set<string>
  nameTerms: Set<string>
  passages: Map<number, string>
}

// ── Corpus 2: the conversations ───────────────────────────────────────────────
//
// The half no document tool can copy, and the half that decides where this code lives. Koda keeps a
// project's conversations in three places (session-store.ts), and a search that reads only the first
// silently answers "we never discussed it" about work the user remembers having:
//
//   1. The HOT store — live sessions, transcript items inline in `koda-sessions-<hash>.json`.
//   2. The COLD archive — one body file per archived session under `koda-archive-<hash>.bodies/`,
//      split out precisely so the hot file stays small. An archived conversation is the NORMAL resting
//      state of finished work, so skipping these would skip most of what there is to find.
//   3. The ENGINE's own `.jsonl` — the durable record for a headless (phone-driven) session, whose
//      transcript never passed through a renderer and therefore has no items in Koda's store at all.
//
// Only the human-readable prose is read: user turns and assistant replies. Tool cards are skipped, and
// that is a judgment, not an oversight. Their content is file bodies and command output, which is the
// weakest possible evidence for "what did we decide" and the largest share of the bytes; it is also the
// text most likely to be something a page or a dependency said rather than something the user did.

function scanSessions(
  root: string,
  terms: string[],
  hotSessionsComplete: boolean,
): { refs: RawRef[]; truncated: boolean } {
  const refs: RawRef[] = []
  let truncated = !hotSessionsComplete

  const hot = listHotSessions(root)
  truncated = truncated || hot.truncated
  if (hot.sessions.length > LIMITS.maxHotSessionsScanned) truncated = true
  const hotIds = new Set<string>()
  for (const s of hot.sessions.slice(0, LIMITS.maxHotSessionsScanned)) {
    // Read structurally rather than trusting the row's declared type: `listHotSessions` is the LEAN
    // read, so these rows have not been through Zod, and a torn or drifted store must cost this walk
    // one conversation rather than the whole answer.
    if (!s || typeof s !== 'object') {
      truncated = true
      continue
    }
    const row = s as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : ''
    if (!id) {
      truncated = true
      continue
    }
    hotIds.add(id)
    if (row.items !== undefined && !Array.isArray(row.items)) truncated = true
    const items = Array.isArray(row.items) ? row.items : []
    const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : root
    // A headless session persists no items, so its conversation only exists in the engine's own file.
    const itemTurns = items.length ? turnsFromItems(items) : { turns: [], truncated: false }
    truncated = truncated || itemTurns.truncated
    let replayEngine: EngineId | undefined
    let replayable = true
    if (row.engineId === undefined) replayEngine = undefined // legacy rows predate engine ids and are Claude
    else if (typeof row.engineId === 'string' && isEngineId(row.engineId)) replayEngine = row.engineId
    else {
      // A present-but-unknown engine is drift, not a legacy Claude row. Guessing here can read a
      // different engine's same-id transcript and present it as evidence for this conversation.
      replayable = false
      truncated = true
    }
    const replay = items.length
      ? { entries: [], truncated: false }
      : replayable
        ? readEngineConversationReplayDetailed(replayEngine, cwd, id, id)
        : { entries: [], truncated: true }
    truncated = truncated || replay.truncated
    const matched = matchConversation(terms, items.length ? itemTurns.turns : turnsFromReplay(replay.entries), {
      label: (typeof row.label === 'string' && row.label.trim()) || 'Untitled conversation',
      sessionId: id,
      archived: false,
      updatedAt: typeof row.lastActivityAt === 'number' ? row.lastActivityAt : 0,
    })
    truncated = truncated || matched.truncated
    if (matched.ref) refs.push(matched.ref)
  }

  let metas: ReturnType<typeof loadArchivedMeta>
  const archiveReport = { dropped: 0 }
  try {
    metas = loadArchivedMeta(root, archiveReport)
  } catch {
    // An unreadable archive index throws by design (it must never read as "nothing archived" to a
    // caller that saves back). Nothing here saves, so the honest response is a thinner answer.
    return { refs, truncated: true }
  }
  if (archiveReport.dropped) truncated = true
  if (metas.length > LIMITS.maxArchivesScanned) truncated = true
  let archiveBytesRead = 0
  const archivedWins = new Set<string>()
  for (const meta of metas.slice(0, LIMITS.maxArchivesScanned)) {
    const remaining = LIMITS.maxArchiveBytesTotal - archiveBytesRead
    if (remaining <= 0) {
      truncated = true
      break
    }
    const body = loadArchivedBodyForSearch(
      root,
      meta.id,
      Math.min(LIMITS.maxArchiveBytesPerSession, remaining),
    )
    archiveBytesRead += Math.min(body.bytes, remaining)
    truncated = truncated || body.truncated
    if (!body.items) {
      truncated = true
      continue // unreadable/over-budget body — keep readable results, but never call them complete
    }
    // An acknowledged archive is the current copy even if an oversized hot save left an older twin.
    // The bounded reader above must prove the body readable before it can outrank that live fallback;
    // a separate unbounded parse here would defeat this search walk's allocation ceiling.
    if (hotIds.has(meta.id)) archivedWins.add(meta.id)
    const itemTurns = turnsFromItems(body.items)
    truncated = truncated || itemTurns.truncated
    const matched = matchConversation(terms, itemTurns.turns, {
      label: meta.label?.trim() || 'Untitled conversation',
      sessionId: meta.id,
      archived: true,
      updatedAt: meta.archivedAt,
    })
    truncated = truncated || matched.truncated
    if (matched.ref) refs.push(matched.ref)
  }
  return {
    refs: archivedWins.size
      ? refs.filter(
          (ref) =>
            !(
              ref.kind === 'session' &&
              ref.archived === false &&
              !!ref.sessionId &&
              archivedWins.has(ref.sessionId)
            ),
        )
      : refs,
    truncated,
  }
}

/** One readable turn of a conversation. `who` is the word the evidence block uses, so the engine can
 *  tell what the user asked for from what the assistant proposed — the same weighting `naming.ts`
 *  makes explicit, where the user's own messages own the subject. */
interface Turn {
  who: 'User' | 'Koda'
  text: string
}

/** Pull the human-readable turns out of the renderer's opaque Entry list (`transcript/types.ts`).
 *  Read structurally: main deliberately stores these as `unknown[]` and must not import the renderer's
 *  model to look at them. */
function turnsFromItems(items: unknown[]): { turns: Turn[]; truncated: boolean } {
  const turns: Turn[] = []
  let truncated = false
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') {
      truncated = true
      continue
    }
    const it = raw as { kind?: string; text?: unknown; markdown?: unknown }
    if (it?.kind === 'user' && typeof it.text === 'string' && it.text.trim()) {
      turns.push({ who: 'User', text: it.text })
    } else if (it?.kind === 'assistant' && typeof it.markdown === 'string' && it.markdown.trim()) {
      turns.push({ who: 'Koda', text: it.markdown })
    } else if (
      (it?.kind === 'user' && typeof it.text !== 'string') ||
      (it?.kind === 'assistant' && typeof it.markdown !== 'string')
    ) {
      truncated = true
    }
  }
  return { turns, truncated }
}

/** The same, from the events `readEngineConversationReplay` rebuilds out of the engine's own `.jsonl`. */
function turnsFromReplay(entries: { type?: string; text?: unknown; markdown?: unknown }[]): Turn[] {
  const turns: Turn[] = []
  for (const e of entries) {
    if (e?.type === 'RemoteUserTurn' && typeof e.text === 'string' && e.text.trim()) {
      turns.push({ who: 'User', text: e.text })
    } else if (e?.type === 'AssistantBlock' && typeof e.markdown === 'string' && e.markdown.trim()) {
      turns.push({ who: 'Koda', text: e.markdown })
    }
  }
  return turns
}

/** Score one conversation's turns against the terms, or null when it holds none of them. */
function matchConversation(
  terms: string[],
  turns: Turn[],
  meta: { label: string; sessionId: string; archived: boolean; updatedAt: number },
): { ref: RawRef | null; truncated: boolean } {
  if (!turns.length) return { ref: null, truncated: false }
  // Newest turns first: a long thread's recent turns are the ones a question is usually about, and it
  // is also where the cap should bite last.
  const window = turns.length > LIMITS.maxTurnsPerSession ? turns.slice(-LIMITS.maxTurnsPerSession) : turns
  let truncated = turns.length > LIMITS.maxTurnsPerSession
  const matched = new Set<string>()
  const passages: LibraryPassage[] = []
  let hits = 0

  for (let i = window.length - 1; i >= 0; i--) {
    const turn = window[i]
    // Not `truncated`: the tail of a huge turn is outside the corpus by policy ("a paste is not a
    // decision"), the same way the walk declines build output. Marking a deliberate corpus rule as a
    // gap fires on nearly every project and drowns the cases where something really was missed.
    const text = turn.text.length > LIMITS.maxTurnChars ? turn.text.slice(0, LIMITS.maxTurnChars) : turn.text
    const lower = text.toLowerCase()
    let first = -1
    for (const term of terms) {
      const at = lower.indexOf(term)
      if (at === -1) continue
      matched.add(term)
      hits += 1
      if (first === -1 || at < first) first = at
    }
    if (first === -1) continue
    if (passages.length < LIMITS.maxPassages) {
      // `windowAround` centres the passage on the match, so the hit is reported either way — a display
      // window is not a missing result. Only a passage we never sent at all (the `else`) is a gap.
      passages.push({ text: `${turn.who}: ${windowAround(text, first)}` })
    } else truncated = true
  }

  if (!matched.size) return { ref: null, truncated }
  return {
    ref: {
      kind: 'session',
      label: meta.label,
      sessionId: meta.sessionId,
      archived: meta.archived,
      passages,
      termsMatched: matched.size,
      score: rank(matched.size, 0, hits),
      updatedAt: meta.updatedAt,
    },
    truncated,
  }
}

/**
 * How a ref ranks. Distinct CONTENT terms dominate, because a source that speaks to three parts of the
 * question beats one that repeats a single word thirty times. Name/title matches are a weak secondary
 * signal, and raw hit count is a tiebreak with a ceiling so length cannot buy rank.
 */
function rank(contentTerms: number, nameTerms: number, hits: number): number {
  return contentTerms * 10 + nameTerms * 2 + Math.min(hits, 20) * 0.1
}

/** Trim a preview to the passage cap (the Find overlay already windowed it around its match). */
function clip(text: string): string {
  const t = text.trim()
  return t.length <= LIMITS.maxPassageChars ? t : `${t.slice(0, LIMITS.maxPassageChars)}…`
}

/** Window a long turn around its first match, so a quote shows the sentence rather than the opening
 *  paragraph of a wall of text. */
function windowAround(text: string, matchIdx: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= LIMITS.maxPassageChars) return collapsed
  // The collapse shifts offsets, so re-anchor on a slice of the original rather than trusting matchIdx.
  const anchor = text.slice(matchIdx, matchIdx + 24).replace(/\s+/g, ' ').trim()
  const at = anchor ? collapsed.indexOf(anchor) : -1
  const start = Math.max(0, (at === -1 ? 0 : at) - LIMITS.previewLead)
  const end = start + LIMITS.maxPassageChars
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`
}
