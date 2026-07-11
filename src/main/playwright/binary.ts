import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the vendored Playwright MCP server + the playwright-core install CLI, or null when the
 * vendor step hasn't run (no `npm run vendor-playwright`). Null is a normal answer — the capability
 * just stays unavailable; like the assist resolver this must NEVER throw (browser-testing is optional).
 *
 * Both files live under one `node_modules` tree staged by scripts/vendor-playwright.mjs:
 *   <root>/playwright/node_modules/@playwright/mcp/cli.js      → the stdio MCP server
 *   <root>/playwright/node_modules/playwright-core/cli.js      → `install chromium` downloader
 *
 * @param opts.resourcesPath  process.resourcesPath in the packaged app (omit in dev/tests).
 */
export function resolvePlaywright(
  opts: { resourcesPath?: string } = {},
): { mcpCli: string; installCli: string } | null {
  const roots: string[] = []
  // 1. Packaged: <Resources>/playwright (electron-builder extraResources).
  if (opts.resourcesPath) roots.push(join(opts.resourcesPath, 'playwright'))
  // 2. Dev: staged by `npm run vendor-playwright`.
  roots.push(join(process.cwd(), 'resources', 'playwright'))

  for (const root of roots) {
    const mcpCli = join(root, 'node_modules', '@playwright', 'mcp', 'cli.js')
    const installCli = join(root, 'node_modules', 'playwright-core', 'cli.js')
    if (existsSync(mcpCli) && existsSync(installCli)) return { mcpCli, installCli }
  }
  return null
}
