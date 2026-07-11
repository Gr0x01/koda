// Compile the local-assist Apple Foundation Models helper for the current platform into
// resources/assist/<platform>/. macOS-only (the framework doesn't exist elsewhere) — skips
// gracefully on other platforms so cross-platform builds don't fail. Code-signing of the
// binary happens later, at electron-builder packaging (hardened runtime), not here.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.log('build-assist-helper: skipped (Apple Foundation Models is macOS-only)')
  process.exit(0)
}

const platform = `${process.platform}-${process.arch}`
const outDir = join('resources', 'assist', platform)
mkdirSync(outDir, { recursive: true })

const src = join('src', 'main', 'assist', 'native', 'assist-helper.swift')
const out = join(outDir, 'assist-helper')

// Always recompile (it's ~2s). An mtime/staleness shortcut risks silently serving an old binary
// across branch switches — the exact silent-fallback bug this helper-build wiring exists to prevent.
try {
  execFileSync('swiftc', ['-O', src, '-o', out, '-framework', 'FoundationModels'], { stdio: 'inherit' })
  console.log(`build-assist-helper: built → ${out}`)
} catch (err) {
  // A RELEASE build must not silently ship without the helper — fail it. Dev keeps warn-and-continue
  // (e.g. no Swift toolchain): the app runs fine on the deterministic fallback.
  if (process.env.KODA_DIST === '1') {
    console.error(`build-assist-helper: FAILED — refusing to package without it: ${err.message}`)
    process.exit(1)
  }
  console.warn(`build-assist-helper: FAILED (assist will use the deterministic fallback): ${err.message}`)
}
