/**
 * The A3 tripwire: code outside a driver never asks WHICH engine it is talking to, it asks WHAT that
 * engine can do (`engine-capabilities.ts`).
 *
 * A3 proved that rule with a one-off grep at merge time, and a one-off grep decays the same week: the
 * very next phase (B2) added `canNameOnEngine() { return engineId === 'claude' }` and nothing noticed.
 * This test is that grep made permanent. It lives under `shared/` so plain `vitest run` picks it up,
 * which means CI already runs it — no workflow change, no separate lint lane to remember.
 *
 * When it fails, the fix is almost never "add yourself to the list". It is to name the BEHAVIOR you
 * actually depend on, declare it once per driver in `EngineCapabilities`, and read it through
 * `engineCapabilities()`. An engine-name branch above the driver means the next fix has to be written
 * twice, and the second copy gets forgotten on whichever engine RB isn't driving that week.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Product source only. `e2e/`, `scripts/`, `spike/`, and `test/` are harnesses, not shipped paths. */
const SCANNED_ROOTS = ['shared', 'src']
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.vite'])
const CODE_FILE = /\.(?:ts|tsx|mts|cts)$/
/** Tests and mocks legitimately name engines — they are the things that ASSERT the split. */
const HARNESS_FILE = /\.(?:test|spec)\.(?:ts|tsx)$/

/**
 * Repo-relative path → why this file is allowed to name an engine. A reason is required: an entry
 * without one is how a temporary exception becomes permanent. Adding a row is a decision to write the
 * next engine fix twice, so it needs an argument, not a shrug.
 */
const ALLOWED: Record<string, string> = {
  'src/main/engine/adapter.ts':
    'the Claude driver — a driver knows what it is; engine-specific transport is exactly its job',
  'src/main/engine/codex-driver.ts': 'the Codex driver — same reason',
  'shared/engine-capabilities.ts':
    'the registration table itself: the one place an engine name maps to declared behavior',
  'src/main/engine/sessions.ts':
    'DRIVER SELECTION (see the two comments by that name) — choosing WHICH driver to launch or fork is what a registry does; every question ABOUT an engine goes through engineCapabilities/engineProfile',
  'src/renderer/src/workspace/ModelControl.tsx':
    'the desktop engine picker — the user is choosing an engine BY NAME, so the name is the subject, not a proxy for behavior',
  'src/renderer/src/settings/GeneratedTextControl.tsx':
    'the generated-text provider/model picker — the user chooses Claude BY NAME alongside local writers, so the name is the subject, not a proxy for session-engine behavior',
  'src/mobile/src/ControlSheet.tsx': 'the phone engine picker — same reason',
  'src/renderer/src/workspace/EngineMark.tsx':
    'the brand mark a session row draws — identity, like accountLabel and the two pickers above: it reports WHOSE engine ran and decides nothing from the answer. It is its own file precisely so this exception cannot spread to cover SessionRow.tsx, where a real behavior branch could hide unnoticed',
  'src/main/api-key.ts':
    "the stored key's filename is a compatibility fact: Claude's `billing-key.enc` predates the per-engine suffix and renaming it would orphan every existing user's key",
  'src/main/engine/usage-scan.ts':
    "the transcript scanner selects a PARSER for each engine's own on-disk file format (Claude project JSONL vs Codex rollout JSONL) — the format is engine-owned, so the name is the subject, like a driver reading its own wire protocol; no session behavior branches on it",
}

/**
 * An engine-name BRANCH: an equality test against an engine id, or a switch case on one. Producing the
 * string (`engineId ?? 'claude'`, a label map, a spawn argument) is not a branch and is not matched —
 * the rule is about deciding behavior from the name, not about the name existing.
 *
 * These deliberately anchor on the OPERATOR and never on the left-hand side, so the shape of the
 * subject is irrelevant: `engineId === 'claude'`, `session.engineId === 'claude'`, `s?.engine ===
 * "codex"`, and `rows[i].engine !== 'claude'` are all one pattern. Do not "tighten" these into
 * identifier-qualified forms — that would narrow real coverage, and the shape test below fails if
 * anyone tries.
 *
 * KNOWN LIMITS, because a grep should be honest about its edges. The scan is line-based (it needs line
 * numbers for the failure message and it skips comment lines), so a comparison split across lines
 * escapes; so does indirection through a constant (`if (id === CLAUDE)`) and a membership test
 * (`['claude','codex'].includes(id)`). Indirection is beyond any grep. The rest are rare enough under
 * this repo's formatting to be worth less than the false positives a whole-file scan would add.
 */
const PATTERNS = [
  /[!=]==?\s*['"](?:claude|codex)['"]/,
  /['"](?:claude|codex)['"]\s*[!=]==?/,
  /\bcase\s+['"](?:claude|codex)['"]\s*:/,
]

/** Comment lines are prose about the rule, not the rule being broken (this file is full of them). */
function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function codeFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) codeFiles(full, into)
    else if (CODE_FILE.test(entry) && !HARNESS_FILE.test(entry)) into.push(full)
  }
  return into
}

/** Every engine-name branch in the scanned tree, as `path:line — source`, ready to read in a diff. */
function findBranches(): { path: string; hit: string }[] {
  const hits: { path: string; hit: string }[] = []
  for (const root of SCANNED_ROOTS) {
    for (const file of codeFiles(join(ROOT, root))) {
      const path = relative(ROOT, file).split('\\').join('/')
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isCommentLine(line)) return
          if (PATTERNS.some((p) => p.test(line)))
            hits.push({ path, hit: `${path}:${i + 1} — ${line.trim()}` })
        })
    }
  }
  return hits
}

describe('engine-name branches', () => {
  it('exist only in a driver, the capability table, or a site that declares why', () => {
    const strays = findBranches()
      .filter((h) => !(h.path in ALLOWED))
      .map((h) => h.hit)
      .sort()
    expect(
      strays,
      'An engine-name branch appeared outside a driver. Name the behavior you depend on, add it to ' +
        'EngineCapabilities in shared/engine-capabilities.ts, and read it through engineCapabilities(). ' +
        'If the engine name really is the subject (a picker, a filename, driver selection), add the file ' +
        'to ALLOWED in this test WITH the reason.',
    ).toEqual([])
  })

  it('keeps its allowlist pointing at files that still exist', () => {
    // A renamed or deleted allowlisted file must not quietly widen the net: without this, the entry
    // rots and its replacement path is unguarded.
    const missing: string[] = []
    for (const path of Object.keys(ALLOWED)) {
      try {
        statSync(join(ROOT, path))
      } catch {
        missing.push(path)
      }
    }
    expect(missing).toEqual([])
  })

  it('actually matches the shapes it claims to (the tripwire has teeth)', () => {
    const branches = [
      // Bare identifier.
      "if (engineId === 'codex') {",
      "const x = engine !== 'claude'",
      "return 'codex' === id",
      "  case 'claude':",
      'if (engineId == "codex") return',
      // Property-qualified, optional-chained, indexed, and `this`-rooted subjects. These are the
      // realistic shapes once an engine id is carried on a session/row/store object, and they matter
      // most: a reviewer reading only the first group could believe the guard is identifier-only.
      "if (session.engineId === 'claude') {",
      'if (s?.engine === "codex") return',
      "if (this.state.engineId !== 'claude') return",
      "const locked = rows[i].engine == 'codex'",
      "switch (session.engineId) { case 'codex': break }",
      'if (opts.engineId==="claude") x()',
    ]
    const notBranches = [
      "const id: EngineId = raw ?? 'claude'",
      "spawn(bin, ['--engine', 'codex'])",
      "if (model !== 'claude-sonnet-4-6') return",
      "engineCapabilities(id).delegation === 'subagents'",
      "const label = { claude: 'Claude', codex: 'OpenAI' }[id]",
      "log.info('naming', 'falling back', { engineId })",
    ]
    for (const line of branches) expect(PATTERNS.some((p) => p.test(line))).toBe(true)
    for (const line of notBranches) expect(PATTERNS.some((p) => p.test(line))).toBe(false)
  })
})
