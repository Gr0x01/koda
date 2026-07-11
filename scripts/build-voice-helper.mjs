// Compile the on-device voice (Speech) helper for the current platform into resources/voice/<platform>/.
// macOS-only (the Speech/AVFoundation frameworks don't exist elsewhere) — skips gracefully on other
// platforms so cross-platform builds don't fail. Code-signing of the binary happens later, at
// electron-builder packaging (hardened runtime), not here.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.log('build-voice-helper: skipped (macOS Speech is macOS-only)')
  process.exit(0)
}

const platform = `${process.platform}-${process.arch}`
const outDir = join('resources', 'voice', platform)
mkdirSync(outDir, { recursive: true })

const src = join('src', 'main', 'voice', 'native', 'voice-helper.swift')
const out = join(outDir, 'voice-helper')

// Always recompile (it's a couple seconds). An mtime/staleness shortcut risks silently serving an old
// binary across branch switches — the exact silent-stale bug this helper-build wiring exists to prevent.
try {
  execFileSync('swiftc', ['-O', src, '-o', out, '-framework', 'Speech', '-framework', 'AVFoundation'], {
    stdio: 'inherit',
  })
  console.log(`build-voice-helper: built → ${out}`)
} catch (err) {
  // A RELEASE build must not silently ship without voice — fail it. Dev keeps warn-and-continue
  // (e.g. no Swift toolchain): the app runs, the mic button just stays unavailable.
  if (process.env.KODA_DIST === '1') {
    console.error(`build-voice-helper: FAILED — refusing to package without it: ${err.message}`)
    process.exit(1)
  }
  console.warn(`build-voice-helper: FAILED (voice input will be unavailable): ${err.message}`)
}
