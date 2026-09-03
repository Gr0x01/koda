import type { Entry } from './types'
import { fleetEntryIsLive, isFleetEntry, type FleetEntry } from './fleet'

/**
 * How the transcript decides what to SHOW. Pure (no React, no store) so the rules are testable and
 * the component stays a renderer.
 *
 * Three folds, one idea — the conversation is the artifact, the plumbing is not:
 *
 *  1. While a turn runs, a run of consecutive plumbing rows collapses to ONE object: a strip naming
 *     what it's doing now and how much it has done. Never a stack that grows to the height of the
 *     viewport, and never more than one work object between two paragraphs of the answer.
 *  2. A turn's delegated agents collapse into ONE row where the first one launched. A fan-out is one
 *     event in the conversation ("Kicked off 3 agents"); the roster of who is doing what opens on the
 *     Agents surface, which is where you go to watch it.
 *  3. Once the turn settles, everything it did collapses behind one "Worked · N steps" line, leaving
 *     your message and the agent's answer. Scrollback is prose.
 *
 * All three are one click from the full detail, and none drops anything from the item list — folding
 * is a view over the same entries.
 */

export type UserEntry = Extract<Entry, { kind: 'user' }>

export type RenderNode =
  /** Anything that carries its own container — prose, a card, a question. */
  | { type: 'item'; entry: Entry }
  /** A run of consecutive plumbing rows, rendered as one work object. */
  | {
      type: 'group'
      key: string
      entries: Entry[]
      /** This run stands behind a strip. False once the turn settles and the reader opens it, where
       *  the run is already inside the turn's own fold and a second door would be one too many. */
      collapsed: boolean
      /** The reader opened this strip. */
      expanded: boolean
      /** The agent is working HERE — the tail of the live turn. Drives the strip's live readout, and
       *  is what lets the trailing working line be absorbed instead of duplicated under it. */
      live: boolean
    }
  /** A turn's delegated agents, as one row anchored where the first one launched. */
  | { type: 'fleet'; key: string; entries: FleetEntry[] }

export type Turn = {
  id: number
  header: UserEntry | null
  /** The settled turn's "Worked for 2m 14s" toggle, or null when there is nothing worth hiding.
   *  `elapsedMs` is absent on turns that ran before Koda timed them — those count steps instead. */
  fold: { count: number; elapsedMs?: number; expanded: boolean } | null
  body: RenderNode[]
}

/** Elapsed time as a person would say it: `12s`, `2m 14s`, `1h 4m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const NO_TURNS: ReadonlySet<number> = new Set<number>()
const NO_RUNS: ReadonlySet<string> = new Set<string>()

/** The agent's mechanical work: tool steps and the thinking line. */
export function isPlumbing(item: Entry): boolean {
  if (item.kind === 'thinking') return true
  // AskUserQuestion renders as a QuestionCard, not a tool row — it's a question, not plumbing.
  if (item.kind === 'tool' && item.name !== 'AskUserQuestion') return true
  return false
}

/**
 * Work that outlives the turn that started it, so the turn fold must not take it with it: a live
 * fan-out (folding it makes running work invisible), a system notice, and the user's own answered
 * question.
 *
 * `liveFleet` is decided for the whole turn, not per entry: the fleet row counts the batch, so a turn
 * with two finished agents and one still going has to keep all three or the row reads "1 agent".
 */
function survivesFold(entry: Entry, liveFleet: boolean): boolean {
  switch (entry.kind) {
    case 'notice':
      return true
    case 'subagent':
    case 'workflow':
      return liveFleet
    case 'tool':
      return entry.name === 'AskUserQuestion'
    default:
      return false
  }
}

type RawTurn = { id: number; header: UserEntry | null; entries: Entry[] }

/**
 * A turn = the user's message (its sticky header) + everything the agent did in response. Items before
 * the first user message form a leading headerless turn (rare — a system notice on resume).
 */
function splitTurns(items: Entry[]): RawTurn[] {
  const turns: RawTurn[] = []
  let current: RawTurn = { id: -1, header: null, entries: [] }
  items.forEach((item) => {
    if (item.kind === 'user') {
      if (current.header || current.entries.length) turns.push(current)
      current = { id: item.id, header: item, entries: [] }
      return
    }
    current.entries.push(item)
  })
  if (current.header || current.entries.length) turns.push(current)
  return turns
}

function toNodes(entries: Entry[], collapseRuns: boolean, expandedRuns: ReadonlySet<string>): RenderNode[] {
  const nodes: RenderNode[] = []
  let run: Entry[] = []
  // The turn's ONE fleet row, created where the first delegate launched and filled by the rest. Items
  // keep their spawn order in the store, so the row can never drift down the conversation behind the
  // newest progress tick (t3.codes hit exactly that, and mid-run it read as no visualization at all).
  let fleet: { type: 'fleet'; key: string; entries: FleetEntry[] } | null = null
  const flush = (): void => {
    if (!run.length) return
    const key = `g${run[0].id}`
    // Every entry rides along whether the run is shut or open: the strip reads the newest one to say
    // what it's holding, so slicing here would leave it describing a step it isn't hiding.
    nodes.push({ type: 'group', key, entries: run, collapsed: collapseRuns, expanded: expandedRuns.has(key), live: false })
    run = []
  }
  entries.forEach((entry) => {
    if (isPlumbing(entry)) {
      run.push(entry)
      return
    }
    flush()
    if (isFleetEntry(entry)) {
      if (fleet) {
        fleet.entries.push(entry)
        return
      }
      fleet = { type: 'fleet', key: `f${entry.id}`, entries: [entry] }
      nodes.push(fleet)
      return
    }
    nodes.push({ type: 'item', entry })
  })
  flush()
  return nodes
}

/**
 * The transcript's render plan. `live` is the session's working posture (busy, or a delegate still
 * running) — the last turn is the only one that can be unsettled, and only while it's true.
 */
export function buildTurns(
  items: Entry[],
  opts: {
    live?: boolean
    expandedTurns?: ReadonlySet<number>
    expandedRuns?: ReadonlySet<string>
  } = {},
): Turn[] {
  const { live = false, expandedTurns = NO_TURNS, expandedRuns = NO_RUNS } = opts
  const raw = splitTurns(items)
  return raw.map((turn, index) => {
    const settled = !(live && index === raw.length - 1)
    if (!settled) {
      const body = toNodes(turn.entries, true, expandedRuns)
      // The agent is working at the tail. Only a run sitting THERE is live — a run the answer has
      // already scrolled past is finished work, and a second pulsing strip would say otherwise.
      const tail = body[body.length - 1]
      if (tail?.type === 'group') tail.live = true
      return { id: turn.id, header: turn.header, fold: null, body }
    }
    // The turn's answer is its LAST prose block; earlier prose is narration of work that's now folded.
    // That split leans on the agent putting substance last, and an agent that breaks the contract
    // would have its real reply silently swallowed behind the fold. So the fold fails OPEN: an
    // earlier block that outweighs BOTH the final one and a tweet-sized floor reads as substance,
    // not narration, and stays visible. The floor is what keeps a status line above a terse closer
    // from surfacing as noise — a genuinely swallowed answer runs paragraphs, not a sentence.
    let answer: Entry | undefined
    let answerLength = 0
    for (let i = turn.entries.length - 1; i >= 0; i--) {
      const entry = turn.entries[i]
      if (entry.kind === 'assistant') {
        answer = entry
        answerLength = entry.markdown.length
        break
      }
    }
    const liveFleet = turn.entries.some((entry) => isFleetEntry(entry) && fleetEntryIsLive(entry))
    const substanceFloor = Math.max(answerLength, 280)
    const kept = turn.entries.filter(
      (e) => e === answer || (e.kind === 'assistant' && e.markdown.length > substanceFloor) || survivesFold(e, liveFleet),
    )
    const count = turn.entries.length - kept.length
    if (count === 0) {
      return { id: turn.id, header: turn.header, fold: null, body: toNodes(turn.entries, false, expandedRuns) }
    }
    const expanded = expandedTurns.has(turn.id)
    return {
      id: turn.id,
      header: turn.header,
      fold: { count, elapsedMs: turn.header?.elapsedMs, expanded },
      body: toNodes(expanded ? turn.entries : kept, false, expandedRuns),
    }
  })
}
