#!/usr/bin/env node
/**
 * Vendor the official Playwright MCP server into resources/playwright/ (the agent's optional
 * browser-testing capability). Mirrors fetch-engine.mjs: the staged tree is NOT committed
 * (gitignored, ~17 MB of JS); this runs before packaging (`npm run dist`) and on demand for dev.
 *
 * What it stages: `@playwright/mcp` (the stdio MCP server, run via Electron-as-node at session
 * spawn) and its `playwright-core` dep (whose `cli.js install chromium` the PlaywrightManager drives
 * to download browser binaries into the user's shared dir at enable-time — those are NOT bundled).
 *
 * Idempotent: an unchanged pinned version is left in place. Only the JS is vendored here; the
 * ~150 MB Chromium download happens on the user's machine when they turn the capability on.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned deliberately (bump intentionally). @playwright/mcp pins its own playwright-core, so the
// MCP server and the browsers the install CLI fetches stay version-matched.
const PINNED = '@playwright/mcp@0.0.76'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'playwright')
const mcpPkg = join(outDir, 'node_modules', '@playwright', 'mcp', 'package.json')

function installedVersion() {
  try {
    return JSON.parse(readFileSync(mcpPkg, 'utf8')).version
  } catch {
    return null
  }
}

const want = PINNED.split('@').pop() // "0.0.76"
if (installedVersion() === want) {
  console.log(`✓ playwright mcp already vendored (${want})`)
} else {
  console.log(`↓ vendoring ${PINNED} → resources/playwright …`)
  // --prefix stages into resources/playwright/node_modules (its own package.json + lockfile).
  execFileSync('npm', ['install', PINNED, '--prefix', outDir, '--no-audit', '--no-fund'], {
    stdio: 'inherit',
  })
}

// Loud failure before packaging: the MCP cli + the install CLI must both be on disk.
const mcpCli = join(outDir, 'node_modules', '@playwright', 'mcp', 'cli.js')
const installCli = join(outDir, 'node_modules', 'playwright-core', 'cli.js')
const missing = [mcpCli, installCli].filter((p) => !existsSync(p))
if (missing.length) throw new Error(`playwright vendor incomplete: missing ${missing.join(', ')}`)
console.log(`✓ playwright mcp vendored (${installedVersion()}).`)
