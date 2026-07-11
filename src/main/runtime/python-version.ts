/**
 * The pinned Python runtime Koda provisions on demand (for machines that have no Python the agent
 * can drive — or only the locked-down system `python3`).
 *
 * Source is python-build-standalone (astral-sh) — the de-facto relocatable, sudo-free CPython for
 * macOS. We use the `install_only` build: a self-contained, relocatable tree that extracts to a
 * top-level `python/` dir (so `--strip-components=1` lands `bin/python3` + `bin/pip3` directly,
 * exactly like the Node tarball). Pin is two coordinates — the CPython version and the release tag —
 * bumped deliberately in a code change. We fetch the release's SHA256SUMS live at install time and
 * SHA-256-verify, so there's no per-version hash to maintain here (same posture as node-version.ts).
 */

/** CPython + the python-build-standalone release that ships it. Both move together — bump as a pair. */
export const PYTHON_VERSION = '3.13.14'
export const RELEASE_TAG = '20260623'

/** aarch64-apple-darwin / x86_64-apple-darwin — generic over arch so an Intel build works unchanged. */
function platform(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  return `${arch}-apple-darwin`
}

/** e.g. `cpython-3.13.14+20260623-aarch64-apple-darwin-install_only.tar.gz` — also the SHA256SUMS key. */
export function tarballName(): string {
  return `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${platform()}-install_only.tar.gz`
}

function releaseBase(): string {
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}`
}

export function tarballUrl(): string {
  return `${releaseBase()}/${tarballName()}`
}

/** The release's combined checksum file — `<sha256>␠␠<filename>` lines, same format as Node's. */
export function shasumsUrl(): string {
  return `${releaseBase()}/SHA256SUMS`
}
