#!/usr/bin/env node
/**
 * Guard on the server-advertised version floor vs. Koda's pinned bundled engine.
 *
 * WHY: Koda freezes one engine version per release (scripts/fetch-engine.mjs → PINNED_VERSION) and never
 * lets it self-update (see architecture/engine-updates.md + the shared-home drift note). The one condition
 * that breaks that frozen bundle is Anthropic raising the server-advertised MINIMUM version above ours —
 * then the pinned engine starts refusing to run. That floor is fetched from GrowthBook at engine startup
 * and cached in `~/.claude.json` under `.cachedGrowthBookFeatures.*.{minVersion,min_version}`. The floors
 * that matter to Koda specifically are the stream-json BRIDGE floors (`tengu_bridge_*`) — that's the `-p`
 * driver Koda runs on — plus the global `tengu_version_config` start floor. This script reads whichever
 * floor is highest and compares it to PINNED_VERSION, so CI can warn before users hit it.
 *
 * It does NOT spawn an engine — it reads the config an already-authenticated engine run wrote (in CI, the
 * engine-contract smoke test authenticates via ANTHROPIC_API_KEY and drives real turns, which populates
 * `.cachedGrowthBookFeatures`). An isolated CLAUDE_CONFIG_DIR without a logged-in account never fetches
 * GrowthBook, so this reuses the smoke test's config rather than doing its own throwaway auth.
 *
 *   node scripts/check-engine-floor.mjs [--config ~/.claude.json] [--warn-patches 40]
 *
 * Exit code is always 0 (this is a watch, not a gate). Signals live in stdout + $GITHUB_OUTPUT:
 *   level=ok|warn|critical|unknown, floor=<x.y.z>, floorKey=<feature>, pinned=<x.y.z>
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const configPath = arg('config', join(homedir(), '.claude.json'))
// Same major.minor as pinned AND this many patches (or fewer) below it ⇒ warn. Floors move slowly and stay
// far behind (global 1.0.24, bridge 2.1.139 vs pinned 2.1.197 today), so this only fires once one closes in.
const WARN_PATCHES = Number(arg('warn-patches', '40'))

const parse = (v) => {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const fmt = (a) => a.join('.')

const emitOutput = (kv) => {
  const line = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line)
}
const done = (level, extra = {}) => {
  emitOutput({ level, ...extra })
  process.exit(0)
}

// The pinned version we actually ship — the thing the floor must stay below.
let pinnedRaw
try {
  pinnedRaw = readFileSync('scripts/fetch-engine.mjs', 'utf8').match(/PINNED_VERSION\s*=\s*'([^']+)'/)?.[1]
} catch {
  /* handled below */
}
const pinned = pinnedRaw && parse(pinnedRaw)
if (!pinned) {
  console.log('::notice::could not read PINNED_VERSION from scripts/fetch-engine.mjs — skipping floor check')
  done('unknown')
}

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch {
  console.log(`::notice::no engine config at ${configPath} (did an authenticated engine run?) — skipping floor check`)
  done('unknown', { pinned: fmt(pinned) })
}

const features = config.cachedGrowthBookFeatures
if (!features || typeof features !== 'object') {
  console.log('::notice::config has no cachedGrowthBookFeatures — the engine did not fetch version config this run; skipping')
  done('unknown', { pinned: fmt(pinned) })
}

// Collect every advertised floor. `tengu_version_config` = global "engine won't start" floor;
// `tengu_bridge_*` = the stream-json bridge floors that gate Koda's `-p` driver specifically. Any of them
// exceeding pinned breaks something, so we take the highest as the binding constraint.
const floors = []
for (const [key, val] of Object.entries(features)) {
  if (val && typeof val === 'object') {
    const raw = val.minVersion ?? val.min_version
    const v = raw && parse(raw)
    if (v) floors.push({ key, v, raw })
  }
}

if (floors.length === 0) {
  console.log('::notice::no *.minVersion floors found in cachedGrowthBookFeatures — skipping')
  done('unknown', { pinned: fmt(pinned) })
}

floors.sort((a, b) => cmp(b.v, a.v))
const highest = floors[0]

console.log(`pinned engine: ${fmt(pinned)}`)
console.log('server floors (highest first):')
for (const f of floors) console.log(`  ${f.key} = ${f.raw}`)

const sameTrack = highest.v[0] === pinned[0] && highest.v[1] === pinned[1]
const patchesBehind = sameTrack ? pinned[2] - highest.v[2] : null

let level
if (cmp(highest.v, pinned) >= 0) {
  level = 'critical' // the floor already meets/exceeds our pinned bundle — it would be refused
} else if (sameTrack && patchesBehind <= WARN_PATCHES) {
  level = 'warn' // same major.minor and closing in
} else {
  level = 'ok'
}

const gap = sameTrack ? `${patchesBehind} patch releases below pinned` : `a full minor+ below pinned`
if (level === 'critical') {
  console.log(`::error::Server floor ${highest.raw} (${highest.key}) has reached Koda's pinned engine ${fmt(pinned)} — the bundled engine will be refused. Re-bundle above the floor NOW.`)
} else if (level === 'warn') {
  console.log(`::warning::Server floor ${highest.raw} (${highest.key}) is ${gap} (Koda pins ${fmt(pinned)}). Plan a re-bundle before it catches up.`)
} else {
  console.log(`::notice::Server floor ${highest.raw} (${highest.key}) is ${gap} — safe headroom.`)
}

done(level, { floor: fmt(highest.v), floorKey: highest.key, pinned: fmt(pinned), patchesBehind: patchesBehind ?? '' })
