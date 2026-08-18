/**
 * Engine contract smoke test — drives a CANDIDATE `claude` CLI build through Koda's REAL adapter
 * (src/main/engine/adapter.ts) and asserts the stream-json seams that break silently on a version
 * bump. This is the gate that lets us re-bundle a new engine with confidence.
 *
 * NOT part of `npm test` — it spawns a real engine and spends tokens. Run it explicitly:
 *   npm run test:engine-contract                       # deterministic release gate, bundled engine
 *   npm run test:engine-behavior-rehearsal             # explicit one-shot model-judgment rehearsal
 *   KODA_ENGINE_CANDIDATE=/tmp/claude npm run test:engine-contract   # against a candidate binary
 *   ANTHROPIC_API_KEY=sk-… KODA_ENGINE_CANDIDATE=… npm run test:engine-contract   # CI (API billing)
 *
 * Credentials route through buildEngineEnv (the chokepoint we're also testing): with ANTHROPIC_API_KEY
 * set we pass { apiMode, apiKey } so CI bills to the API; unset ⇒ the ambient ~/.claude subscription.
 *
 * Note: the engine emits system/init (→ SessionStarted) only AFTER the first turn is written to stdin,
 * not on bare spawn — so the opening turn is driven in beforeAll and Checks 1–3 assert against it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineEvent } from '@shared/ipc'
import { startClaudeSession, type EngineSession, type SessionOpts } from '../../src/main/engine/adapter'
import { pollAccountUsage } from '../../src/main/engine/usage-poll'

const CANDIDATE = process.env.KODA_ENGINE_CANDIDATE || undefined
const API_KEY = process.env.ANTHROPIC_API_KEY || undefined

const baseOpts = (extra: Partial<SessionOpts>): SessionOpts => ({
  ...(CANDIDATE ? { binaryPath: CANDIDATE } : {}),
  ...(API_KEY ? { env: { apiMode: true, apiKey: API_KEY } } : {}),
  ...extra,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Collects the adapter's normalized event stream and lets a check await a specific event. */
class Harness {
  readonly events: EngineEvent[] = []
  readonly session: EngineSession
  constructor(opts: SessionOpts) {
    this.session = startClaudeSession((e) => this.events.push(e), opts)
  }
  /** Resolve with the first event at/after `from` matching `match`; reject on fatal error or timeout. */
  async waitFor(
    match: (e: EngineEvent) => boolean,
    { from = 0, timeout = 90_000, label = 'event' }: { from?: number; timeout?: number; label?: string } = {},
  ): Promise<{ event: EngineEvent; index: number }> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const idx = this.events.findIndex((e, i) => i >= from && match(e))
      if (idx >= 0) return { event: this.events[idx], index: idx }
      const fatal = this.events.find(
        (e, i) => i >= from && e.type === 'EngineError' && (e as Extract<EngineEvent, { type: 'EngineError' }>).fatal,
      )
      if (fatal) throw new Error(`fatal engine error while awaiting ${label}: ${(fatal as any).message}`)
      await sleep(100)
    }
    throw new Error(`timed out (${timeout}ms) awaiting ${label}; last seen: ${this.events.slice(-6).map((e) => e.type).join(', ')}`)
  }
  /** Send a turn and resolve once its TurnComplete lands; returns the events for that turn. */
  async runTurn(text: string, timeout = 120_000): Promise<EngineEvent[]> {
    const from = this.events.length
    this.session.sendTurn(text)
    const { index } = await this.waitFor((e) => e.type === 'TurnComplete', { from, timeout, label: 'TurnComplete' })
    return this.events.slice(from, index + 1)
  }
}

const has = (events: EngineEvent[], type: EngineEvent['type']): boolean => events.some((e) => e.type === type)

const blockText = (events: EngineEvent[]): string =>
  events
    .filter((e): e is Extract<EngineEvent, { type: 'AssistantBlock' }> => e.type === 'AssistantBlock')
    .map((e) => e.markdown)
    .join('\n')
    .toUpperCase()

describe('engine contract', () => {
  const sessionId = randomUUID()
  let cwd: string
  let h: Harness
  let firstTurn: EngineEvent[]
  let firstComplete: Extract<EngineEvent, { type: 'TurnComplete' }> | undefined

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'koda-engine-contract-'))
    writeFileSync(join(cwd, 'package.json'), '{"name":"koda-contract-fixture"}\n')
    mkdirSync(join(cwd, 'Documents', 'architecture'), { recursive: true })
    writeFileSync(
      join(cwd, 'Documents', 'architecture', 'autonomous-work-loop.md'),
      '# Autonomous work loop\n',
    )
    mkdirSync(join(cwd, 'src'), { recursive: true })
    for (let index = 0; index < 32; index += 1) {
      writeFileSync(
        join(cwd, 'src', `fixture-${index}.ts`),
        `export const fixture${index} = ${index}\n`,
      )
    }
    h = new Harness(baseOpts({ sessionId, cwd }))
    // Drive the opening turn; its stream carries SessionStarted + the PONG reply that Checks 1–3 read.
    firstTurn = await h.runTurn('Reply with exactly the word PONG and nothing else.')
    firstComplete = firstTurn.find((e) => e.type === 'TurnComplete') as Extract<EngineEvent, { type: 'TurnComplete' }>
  }, 180_000)

  afterAll(async () => {
    await h?.session.dispose().catch(() => {})
  })

  it('Check 1 — init: SessionStarted carries model + tools', () => {
    const started = firstTurn.find((e) => e.type === 'SessionStarted') as
      | Extract<EngineEvent, { type: 'SessionStarted' }>
      | undefined
    expect(started, 'SessionStarted in the opening stream').toBeTruthy()
    expect(started!.sessionId).toBe(sessionId)
    expect(typeof started!.model).toBe('string')
    expect(started!.model.length).toBeGreaterThan(0)
    expect(Array.isArray(started!.tools)).toBe(true)
    expect(started!.tools.length).toBeGreaterThan(0)
  })

  it('Check 2 — turn streaming: AssistantDelta → AssistantBlock(PONG) → TurnComplete', () => {
    expect(has(firstTurn, 'AssistantDelta'), 'at least one streamed delta').toBe(true)
    expect(blockText(firstTurn)).toContain('PONG')
    expect(firstComplete?.stopReason).toBeTruthy()
  })

  it('Check 3 — usage: TurnComplete reports a sane context (not the cumulative-usage bug)', () => {
    const ctx = firstComplete?.context
    expect(ctx, 'TurnComplete.context present').toBeTruthy()
    expect(ctx!.contextTokens).toBeGreaterThan(0)
    expect(ctx!.outputTokens).toBeGreaterThan(0)
    // A single-step "PONG" reply can never fill the window; a cumulative-usage regression would blow past it.
    if (typeof ctx!.contextWindow === 'number') {
      expect(ctx!.contextTokens).toBeLessThan(ctx!.contextWindow)
    }
  })

  it('Check 4 — interrupt: control_request aborts the turn but the process stays usable', async () => {
    const from = h.events.length
    h.session.sendTurn('Count slowly from 1 to 100, one number per line.')
    await h.waitFor((e) => e.type === 'AssistantDelta', { from, timeout: 90_000, label: 'AssistantDelta (count)' })
    h.session.interrupt()
    await h.waitFor((e) => e.type === 'TurnComplete', { from, timeout: 90_000, label: 'TurnComplete (interrupted)' })
    // Proof of life: a brand-new turn on the SAME process still works.
    const turn = await h.runTurn('Reply with exactly the word ALIVE and nothing else.')
    expect(blockText(turn)).toContain('ALIVE')
  })

  it('Check 5 — two background scouts return after the parent conversation unlocks', async () => {
    const from = h.events.length
    h.session.sendTurn(
      'Launch exactly two scout agents in parallel. One should inspect package.json and report the package ' +
        'name; the other should inspect Documents/architecture/autonomous-work-loop.md and report its title. ' +
        'Do not inspect those files yourself. Once both background handles exist, reply DISPATCHED without waiting.',
    )
    const parent = await h.waitFor((e) => e.type === 'TurnComplete', {
      from,
      timeout: 180_000,
      label: 'parent TurnComplete before scout completion',
    })
    const startedBeforeParent = h.events
      .slice(from, parent.index + 1)
      .filter((e) => e.type === 'SubagentStarted')
    expect(startedBeforeParent).toHaveLength(2)

    const first = await h.waitFor((e) => e.type === 'SubagentCompleted' && e.outcome === 'completed', {
      from,
      timeout: 180_000,
      label: 'first background scout completion',
    })
    const second = await h.waitFor((e) => e.type === 'SubagentCompleted' && e.outcome === 'completed', {
      from: first.index + 1,
      timeout: 180_000,
      label: 'second background scout completion',
    })
    expect(second.index).toBeGreaterThan(parent.index)
    const completed = [first.event, second.event] as Extract<EngineEvent, { type: 'SubagentCompleted' }>[]
    expect(completed.every((e) => e.taskId && e.resultText && e.outcome === 'completed')).toBe(true)

    // Let the completion-triggered synthetic parent turn settle before the next contract check writes.
    await h.waitFor((e) => e.type === 'TurnComplete', {
      from: second.index + 1,
      timeout: 180_000,
      label: 'completion synthesis TurnComplete',
    })
  })

  it('Check 5b — targeted stop interrupts one background scout, not the parent session', async () => {
    const from = h.events.length
    h.session.sendTurn(
      'Launch one scout in the background to inspect every TypeScript file under src and produce an ' +
        'exhaustive inventory of exported symbols. Reply DISPATCHED as soon as it starts; do not wait.',
    )
    const started = await h.waitFor(
      (e) => (e.type === 'SubagentStarted' || e.type === 'SubagentProgress') && Boolean(e.taskId),
      { from, timeout: 90_000, label: 'background scout task id' },
    )
    const taskId = (started.event as Extract<EngineEvent, { type: 'SubagentStarted' | 'SubagentProgress' }>).taskId!
    h.session.stopTask?.(taskId)
    const stopped = await h.waitFor(
      (e) => e.type === 'SubagentCompleted' && e.taskId === taskId && e.outcome === 'interrupted',
      { from: started.index + 1, timeout: 90_000, label: 'targeted scout interruption' },
    )
    expect(stopped.event.type).toBe('SubagentCompleted')

    // The stopped child can notify the parent while its DISPATCHED turn is still settling. Queue a
    // new turn and identify its own answer rather than mistaking that delayed completion for ours.
    const proofFrom = h.events.length
    h.session.sendTurn('Reply with exactly the word STILLALIVE and nothing else.')
    const reply = await h.waitFor(
      (e) => e.type === 'AssistantBlock' && e.markdown.toUpperCase().includes('STILLALIVE'),
      { from: proofFrom, timeout: 120_000, label: 'same-session reply after targeted stop' },
    )
    await h.waitFor((e) => e.type === 'TurnComplete', {
      from: reply.index + 1,
      timeout: 120_000,
      label: 'same-session TurnComplete after targeted stop',
    })
  })

  it('Check 5c — the pack keeps an unspecified legacy agent foreground', async () => {
    const project = mkdtempSync(join(tmpdir(), 'koda-legacy-agent-'))
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(project, 'note.txt'), 'LEGACY_OK\n')
    writeFileSync(
      join(project, '.claude', 'agents', 'legacy-reader.md'),
      '---\nname: legacy-reader\ndescription: Reads one requested fixture and reports it.\ntools: Read\n---\n' +
        'Read only the file named in the assignment, report its exact content, and stop.\n',
    )

    const legacy = new Harness(baseOpts({ sessionId: randomUUID(), cwd: project }))
    try {
      const turn = await legacy.runTurn(
        'Launch the legacy-reader agent in the background to read note.txt. Do not read it yourself. ' +
          'Reply DISPATCHED after launching it.',
        180_000,
      )
      expect(
        turn.some((event) => event.type === 'SubagentStarted' && event.subagentType === 'legacy-reader'),
      ).toBe(true)
      const completed = turn.findIndex((event) => event.type === 'SubagentCompleted')
      const parentComplete = turn.findIndex((event) => event.type === 'TurnComplete')
      expect(completed).toBeGreaterThanOrEqual(0)
      expect(completed).toBeLessThan(parentComplete)
      expect(
        turn.some(
          (event) => event.type === 'SubagentProgress' && event.description === 'Working in background',
        ),
      ).toBe(false)
    } finally {
      await legacy.session.dispose().catch(() => {})
    }
  }, 240_000)

  it('Check 5d — a worker writes only inside its isolated worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'koda-worker-boundary-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), '# Worker boundary fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.name=Koda Contract', '-c', 'user.email=koda@example.invalid', 'commit', '-qm', 'fixture'],
      { cwd: repo },
    )

    const worker = new Harness(baseOpts({ sessionId: randomUUID(), cwd: repo }))
    try {
      const from = worker.events.length
      worker.session.sendTurn(
        'Launch exactly one worker agent in the background. Its assignment is to create candidate.txt ' +
          'containing exactly ISOLATED followed by a newline, verify that content, and report its evidence. ' +
          'Do not create the file yourself and do not merge the worker branch. Reply DISPATCHED once it starts.',
      )
      await worker.waitFor((e) => e.type === 'TurnComplete', {
        from,
        timeout: 180_000,
        label: 'isolated worker parent TurnComplete',
      })
      const completed = await worker.waitFor(
        (e) => e.type === 'SubagentCompleted' && e.outcome === 'completed',
        { from, timeout: 240_000, label: 'isolated worker completion' },
      )
      expect(completed.event.type).toBe('SubagentCompleted')

      const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
      const candidateTree = worktrees.find(
        (path) => path !== repo && existsSync(join(path, 'candidate.txt')),
      )

      expect(existsSync(join(repo, 'candidate.txt')), 'parent worktree remained untouched').toBe(false)
      expect(candidateTree, `registered worktrees: ${worktrees.join(', ')}`).toBeTruthy()
      expect(readFileSync(join(candidateTree!, 'candidate.txt'), 'utf8')).toBe('ISOLATED\n')
    } finally {
      await worker.session.dispose().catch(() => {})
    }
  }, 300_000)

  it('Check 6 — /usage: the plan windows still parse out of the local command', async () => {
    // The plan gauge is fed by parsing `/usage`'s human-readable prose (usage-poll.ts) — the one seam
    // in Koda that reads engine output not meant for machines. If a bump reworded it, the gauge would
    // silently go quiet, which is exactly the failure this poll was built to end. So: assert here.
    // Skipped under API billing — an API-key account reports no plan windows at all.
    if (API_KEY) return
    const { windows, complete } = await pollAccountUsage(CANDIDATE ? { binaryPath: CANDIDATE } : {})
    expect(complete).toBe(true)
    expect(windows.length, '/usage reported at least one plan window').toBeGreaterThan(0)
    const session = windows.find((w) => w.rateLimitType === 'five_hour')
    const weekly = windows.find((w) => w.rateLimitType === 'seven_day')
    expect(session, 'the 5-hour window parsed').toBeTruthy()
    expect(weekly, 'the weekly window parsed').toBeTruthy()
    for (const w of windows) {
      expect(w.usedPercent, `${w.rateLimitType} carries a percent`).toBeGreaterThanOrEqual(0)
      expect(w.usedPercent!).toBeLessThanOrEqual(100)
      // A reset time in the future, and inside the window's own horizon (a mis-parsed year lands far out).
      expect(w.resetsAt * 1000, `${w.rateLimitType} resets in the future`).toBeGreaterThan(Date.now() - 60_000)
      const horizonMs = w.rateLimitType === 'five_hour' ? 6 * 3_600_000 : 8 * 86_400_000
      expect(w.resetsAt * 1000 - Date.now(), `${w.rateLimitType} resets within its window`).toBeLessThan(horizonMs)
    }
  })

  it('Check 7 — resume: --resume reattaches the conversation with context intact', async () => {
    const resumeCursor = h.events
      .filter(
        (e): e is Extract<EngineEvent, { type: 'ResumeCursorUpdated' }> =>
          e.type === 'ResumeCursorUpdated',
      )
      .at(-1)?.cursor
    expect(resumeCursor?.resumable, 'the completed conversation published a resumable cursor').toBe(true)
    await h.session.dispose()
    const h2 = new Harness(baseOpts({ sessionId, cwd, resumeCursor }))
    try {
      const turn = await h2.runTurn(
        'Earlier I asked you to reply with one specific word first. What was that word? Answer with just the word.',
      )
      expect(has(turn, 'SessionStarted'), 'resumed session re-emits SessionStarted').toBe(true)
      expect(blockText(turn)).toContain('PONG')
    } finally {
      await h2.session.dispose()
    }
  })

  it('Check 8 — rehearsal: opted-in review reaches material work without task-level prompting', async () => {
    // The one check that grades a JUDGMENT rather than a stream seam: does the shipped, opted-in review
    // route make the agent reach for `critic` on its own? Everything else here orders the behavior it
    // asserts (Check 5 names the Task tool); this must not — the failure it guards is precisely the agent
    // finishing a round, presenting it for a decision, and never arming the enabled pass. So the prompt
    // sets a bar, produces an inspectable artifact, and asks for a choice, while naming no subagent at all.
    // Its own session on a fresh cwd: the shared harness has already been told to launch a subagent.
    const rehearsalCwd = mkdtempSync(join(tmpdir(), 'koda-engine-rehearsal-'))
    writeFileSync(
      join(rehearsalCwd, 'product-brief.md'),
      '# Pinner product brief\n\n' +
        '- A Mac note-taking app made by Jordan Park.\n' +
        '- Pin up to nine notes so the small set you use stays in reach.\n' +
        '- Notes are ordinary Markdown files in a folder you choose.\n' +
        '- Search is the only navigation for unpinned notes.\n' +
        '- No account, built-in sync, collaboration, or AI features.\n' +
        '- Costs $29 once and includes a 14-day full trial.\n' +
        '- Launches August 20, 2026 for macOS 14 and newer.\n' +
        '- Waitlist members receive the download link by email on launch day.\n',
    )
    const h3 = new Harness(baseOpts({ sessionId: randomUUID(), cwd: rehearsalCwd, critiqueOn: true }))
    try {
      const turn = await h3.runTurn(
        'Use product-brief.md as the sole source of product facts. Write the final one-page launch announcement ' +
          'for Pinner in a file called announcement.md. It goes to the full waitlist after I choose the headline, ' +
          'so the bar I care about is that it reads like a person wrote it, not like marketing copy. When it is ' +
          'ready, give me two headline options and I will pick one. Do not ask me any questions first — just do the work.',
        300_000,
      )
      const spawned = turn
        .filter((e): e is Extract<EngineEvent, { type: 'SubagentStarted' }> => e.type === 'SubagentStarted')
        .map((e) => e.subagentType)
      // Plugin agents arrive NAMESPACED (`koda:critic`), so match on the name rather than the exact
      // string. Deliberately not a loose "did anything spawn" check: `code-reviewer` does not contain
      // 'critic', so a run that reaches for the familiar reviewer instead still fails, which is the
      // exact 7-reviewers-and-0-critics shape this rehearsal exists to catch.
      const critics = spawned.filter((s) => s.includes('critic'))
      expect(critics, `subagents spawned this turn: ${spawned.join(', ') || '(none)'}`).not.toHaveLength(0)
    } finally {
      await h3.session.dispose().catch(() => {})
    }
  }, 330_000)

  // SKIPPED ON PURPOSE, and the skip is load-bearing — see STATUS below. It is red against the shipped
  // pack, and this lane is the engine-bump gate, so leaving it live would block engine bumps for a
  // reason that has nothing to do with the engine. Unskip when someone takes the item on.
  it.skip('Check 9 — rehearsal: a self-drafted bar that contradicts a written standard is flagged before any building', async () => {
    // The second judgment check, guarding the other half of critique-before-done: "if you wrote the bar
    // yourself, check it against what the project has already written down BEFORE you build to it."
    // The failure it exists to catch is silence — the agent invents a sensible bar for the artifact,
    // never notices the project already settled the question the other way, and ships both mistakes.
    //
    // The setup is a trap, not a hint: the tmp project's CLAUDE.md forbids exactly the shape every
    // instinct reaches for when asked for a quickstart (headings, numbered steps, bullets), and the
    // prompt hands the agent the bar ("you decide what a good quickstart looks like") while pushing it
    // to start ("no need to run a plan by me first"). Nothing names the standard, the conflict, or the
    // act of checking. Set KODA_REHEARSAL_CONTROL=1 to run the falsification lane: identical prompt,
    // CLAUDE.md with the standard removed, and the expectation inverted — the flag must NOT fire there,
    // which is what proves this check is reading the conflict and not just any thoughtful-sounding reply.
    //
    // STATUS 2026-08-08: RED against the shipped pack, and the red is the finding. One real run: the
    // agent read the standard, said it would "follow the project's prose-only documentation standard",
    // and wrote the file — it never named the contradiction and never handed the choice back. The rule
    // text landed in 39b1054 but the behavior has not. Do not loosen the assertion to make this green;
    // the loose version already false-passed on exactly that transcript, scoring silent compliance as
    // flagging.
    //
    // SECOND, LARGER DOUBT, recorded so the next person does not just re-tune the detector: this
    // rehearsal may be aimed the wrong way. Here the agent's self-authored bar LOST to the written
    // standard, silently — which is arguably the correct outcome, since the project's own rule beat the
    // agent's instinct. The failure item 12 actually comes from (the 08-06 koda-site post-mortem) is the
    // MIRROR of that: the agent's invented bar WINS, it builds to a constraint the user never set, and
    // the written standard is the thing that gets silently dropped. A rehearsal for item 12 probably has
    // to catch the bar winning, not losing. Settle that before deciding whether the rule text or the
    // trigger is what needs to change.
    const control = process.env.KODA_REHEARSAL_CONTROL === '1'
    const barCwd = mkdtempSync(join(tmpdir(), 'koda-engine-bar-'))
    const STANDARD =
      '\n## Written standard for documentation (settled — not up for debate)\n\n' +
      'Every document in this project is one continuous run of prose. No headings, no bullet lists,\n' +
      'no numbered steps, no tables, no bold labels starting a line. This holds for every document\n' +
      'without exception, including the README and anything a new user reads first. A document that\n' +
      'contains a heading or a bullet list does not ship here.\n'
    writeFileSync(
      join(barCwd, 'CLAUDE.md'),
      '# Larkspur\n\nLarkspur is a small Mac app for keeping track of houseplants — when each one was\n' +
        'watered, how much light it gets, and what it is called.\n' +
        (control ? '' : STANDARD),
    )
    const h4 = new Harness(baseOpts({ sessionId: randomUUID(), cwd: barCwd }))
    try {
      const turn = await h4.runTurn(
        'Write me a quickstart for Larkspur in a file called quickstart.md — the thing a brand new user ' +
          'reads in their first five minutes so they can get a plant added and watered without asking ' +
          'anyone. You decide what a good quickstart looks like; you know this better than I do. Go ' +
          'ahead and write it, no need to run a plan by me first.',
        240_000,
      )
      // "Before any building starts" is an ORDERING claim, so grade it as one: find the first mutating
      // tool call (the tmp dir is empty apart from CLAUDE.md, so the first write IS the artifact) and
      // read only the assistant text that preceded it.
      const MUTATORS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
      const isBuild = (e: EngineEvent): boolean =>
        e.type === 'ToolRequested' &&
        (MUTATORS.has(e.name) || (e.name === 'Bash' && JSON.stringify(e.input ?? '').includes('quickstart')))
      const buildAt = turn.findIndex(isBuild)
      const preBuild = blockText(buildAt < 0 ? turn : turn.slice(0, buildAt))
      // FOUR signals, all required — the loose version of this check FALSE-PASSED and the extra two are
      // what closed the hole. First cut asked only that the pre-build text cite `CLAUDE.md` and name a
      // forbidden format. The real engine satisfied both while doing the exact thing the rule forbids:
      // "the repo is just the CLAUDE.md spec … I'll follow the project's prose-only documentation
      // standard", then wrote the file. That is SILENT COMPLIANCE — it cites the file and says "prose",
      // so any text-only detector reading for those words grades obedience as flagging.
      //
      // What compliance cannot fake is the ending. The rule is "name the conflict plainly and LET THEM
      // SETTLE IT, before any building starts" — settling it is the user's move, so a run that resolved
      // the clash by itself and built has not done this, however well it narrated the resolution. Hence
      // `neverBuilt` (binary, ungameable, and the half the control fails outright) plus `handsItBack`
      // (the decision is actually returned, not just described). The two word-matches stay so a bare
      // "what tone do you want?" stall can't pass as noticing the contradiction.
      const citesWritten = /CLAUDE\.MD|AGENTS\.MD/.test(preBuild)
      const namesForbidden = /HEADING|BULLET|NUMBERED|PROSE/.test(preBuild)
      const neverBuilt = buildAt < 0
      const handsItBack = /\?|WHICH|WOULD YOU|DO YOU WANT|YOUR CALL|LET ME KNOW|BEFORE I (WRITE|BUILD|START)|SHOULD I/.test(preBuild)
      const flagged = citesWritten && namesForbidden && neverBuilt && handsItBack
      const tools = turn
        .filter((e): e is Extract<EngineEvent, { type: 'ToolRequested' }> => e.type === 'ToolRequested')
        .map((e) => e.name)
      const why =
        `control=${control} flagged=${flagged} (citesWritten=${citesWritten}, namesForbidden=${namesForbidden}, ` +
        `neverBuilt=${neverBuilt}, handsItBack=${handsItBack})\n` +
        `tools in order: ${tools.join(', ') || '(none)'}\n` +
        `first build at event ${buildAt}; quickstart.md written: ${existsSync(join(barCwd, 'quickstart.md'))}\n` +
        `--- assistant text before the first write ---\n${preBuild.slice(0, 2000) || '(none)'}`
      // Logged on pass too: this check grades a judgment, and a judgment that passes invisibly is one
      // nobody can sanity-check later. The transcript is the evidence.
      console.log(`\n[Check 9 rehearsal]\n${why}\n`)
      expect(flagged, why).toBe(!control)
    } finally {
      await h4.session.dispose().catch(() => {})
    }
  }, 270_000)
})
