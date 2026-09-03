// codesign refuses "resource fork, Finder information, or similar detritus" on any file in the
// bundle. Building inside a File Provider-synced folder (and copying node_modules that iOS builds
// touched) tags packed files with com.apple.FinderInfo/provenance, so the 0.1.14 cut failed twice
// on different files. Strip everything after packing, before electron-builder signs.
import { execFileSync } from 'node:child_process'

export default async function afterPack({ appOutDir }) {
  console.log(`  • afterPack: stripping xattrs under ${appOutDir}`)
  execFileSync('/usr/bin/xattr', ['-cr', appOutDir], { stdio: 'inherit' })
}
