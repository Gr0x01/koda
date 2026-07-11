/**
 * The pinned Node.js runtime Koda provisions on demand (for machines that have no Node at all).
 *
 * Bump PINNED_VERSION deliberately, in a code change — it's the only knob. We fetch the matching
 * SHASUMS256.txt live at install time and SHA-256-verify the tarball against it, so there's no
 * per-version hash to maintain here (source-pinning the hash is a noted future hardening step).
 */

/** Current Node LTS ("Krypton") at time of writing. LTS, not latest — stability over newness. */
export const PINNED_VERSION = '24.18.0'

/** darwin-arm64 / darwin-x64 — generic over arch so an Intel build works without changes. */
function platform(): string {
  const arch = process.arch === 'x64' ? 'x64' : 'arm64'
  return `${process.platform}-${arch}`
}

/** The tarball filename, e.g. `node-v24.18.0-darwin-arm64.tar.gz`. Also the key into SHASUMS256.txt. */
export function tarballName(version = PINNED_VERSION): string {
  return `node-v${version}-${platform()}.tar.gz`
}

export function tarballUrl(version = PINNED_VERSION): string {
  return `https://nodejs.org/dist/v${version}/${tarballName(version)}`
}

export function shasumsUrl(version = PINNED_VERSION): string {
  return `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
}
