/**
 * The runtimes Koda can provision on demand. One descriptor per runtime; the provisioner
 * (provision.ts) is generic over them, so adding a third runtime is a registry entry + a UI row —
 * not another copy of the download/verify/extract (and its security-critical checksum check).
 *
 * Every supported runtime ships as a relocatable tarball whose checksums live in a `<hash>␠␠<file>`
 * SHASUMS file at the same origin — Node (nodejs.org SHASUMS256.txt) and python-build-standalone
 * (GitHub-release SHA256SUMS) happen to share that exact format, which is what makes the engine generic.
 */
import type { RuntimeId } from '@shared/ipc'
import * as nodeV from './node-version'
import * as pyV from './python-version'

export interface RuntimeSpec {
  id: RuntimeId
  /** Human label for log lines + progress copy ("Node is ready."). */
  label: string
  /** Plain-language description for the agent's ensure_tool list + the human confirm popup. */
  blurb: string
  /** The pinned version we install (shown in status). */
  pinnedVersion: string
  /** Binary probed in the login PATH to detect a pre-existing system install (and to verify an install). */
  probeBinary: string
  /** Login-PATH dirs that DON'T count as a real user install of this runtime. macOS ships a
   *  `/usr/bin/python3` stub (triggers the CLT installer, PEP-668 restricted), so it must not read as
   *  "already installed" — only a deliberately-installed Python (brew/pyenv/…) should. */
  systemExcludeDirs?: readonly string[]
  /** Path under the install root that must exist after a good extract. */
  verifyRelPath: string
  /** Progress copy shown while downloading. */
  downloadMessage: string
  tarballName: () => string
  tarballUrl: () => string
  shasumsUrl: () => string
}

export const RUNTIMES: Record<RuntimeId, RuntimeSpec> = {
  node: {
    id: 'node',
    label: 'Node',
    blurb: 'the JavaScript runtime — for apps that save data or run a server',
    pinnedVersion: nodeV.PINNED_VERSION,
    probeBinary: 'node',
    verifyRelPath: 'bin/node',
    downloadMessage: 'Downloading Node…',
    tarballName: nodeV.tarballName,
    tarballUrl: nodeV.tarballUrl,
    shasumsUrl: nodeV.shasumsUrl,
  },
  python: {
    id: 'python',
    label: 'Python',
    blurb: 'Python — for data, scripts & AI tools',
    pinnedVersion: pyV.PYTHON_VERSION,
    probeBinary: 'python3',
    systemExcludeDirs: ['/usr/bin'], // the Apple-supplied python3 stub doesn't count
    verifyRelPath: 'bin/python3',
    downloadMessage: 'Downloading Python…',
    tarballName: pyV.tarballName,
    tarballUrl: pyV.tarballUrl,
    shasumsUrl: pyV.shasumsUrl,
  },
}

export const RUNTIME_IDS = Object.keys(RUNTIMES) as RuntimeId[]

// ── Portable CLI tools ────────────────────────────────────────────────────────────────────────────
//
// Single-binary command-line tools the AGENT can request on demand (broker `ensure_tool`), distinct
// from runtimes (which extract to a whole bin/ tree). Each ships a single binary — either inside a
// release tarball or as a bare download — and its checksum source varies per project (some publish a
// per-asset/combined SHASUMS file, fd publishes none → we pin the hex). The provisioner is generic
// over this spec, so adding a tool is a registry entry, not another copy of the verify/extract code.

export type CliId = 'ripgrep' | 'fd' | 'jq'

export type CliArch = 'arm64' | 'x64'
export function cliArch(): CliArch {
  return process.arch === 'x64' ? 'x64' : 'arm64'
}

/** Where the verified SHA-256 comes from: a checksum FILE we fetch (lenient `<hash> … <asset>` match,
 *  covers both per-asset `.sha256` and a combined list) vs an in-repo PINNED hex per arch (for sources
 *  that publish no checksums, e.g. fd — bump alongside pinnedVersion). */
export type ChecksumSpec =
  | { kind: 'file'; url: () => string }
  | { kind: 'pinned'; hex: Record<CliArch, string> }

export interface CliSpec {
  id: CliId
  label: string
  /** Plain-language description for the human confirm popup ("a fast file-search tool"). */
  blurb: string
  pinnedVersion: string
  /** Binary name on PATH — probed for a pre-existing install and the name we install it under. */
  probeBinary: string
  systemExcludeDirs?: readonly string[]
  /** `tar.gz` = extract + lift the binary out; `raw` = the download IS the binary. */
  format: 'tar.gz' | 'raw'
  /** The downloaded asset's filename — also the key we match in a checksum file. */
  assetName: () => string
  assetUrl: () => string
  /** tar.gz only: the binary's path after `--strip-components=1` (defaults to probeBinary). */
  binaryRelPath?: string
  checksum: ChecksumSpec
}

const RG_VER = '14.1.1'
const FD_VER = '10.2.0'
const JQ_VER = '1.7.1'

/** ripgrep + fd name their darwin assets with the Rust triple arch (aarch64 / x86_64). */
function rustArch(): string {
  return cliArch() === 'x64' ? 'x86_64' : 'aarch64'
}

export const CLIS: Record<CliId, CliSpec> = {
  ripgrep: {
    id: 'ripgrep',
    label: 'ripgrep',
    blurb: 'a fast file-search tool',
    pinnedVersion: RG_VER,
    probeBinary: 'rg',
    format: 'tar.gz',
    binaryRelPath: 'rg',
    assetName: () => `ripgrep-${RG_VER}-${rustArch()}-apple-darwin.tar.gz`,
    assetUrl: () => `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VER}/${CLIS.ripgrep.assetName()}`,
    // per-asset companion (`<asset>.sha256`); its line carries a path prefix, so we match leniently.
    checksum: { kind: 'file', url: () => `${CLIS.ripgrep.assetUrl()}.sha256` },
  },
  fd: {
    id: 'fd',
    label: 'fd',
    blurb: 'a fast file finder',
    pinnedVersion: FD_VER,
    probeBinary: 'fd',
    format: 'tar.gz',
    binaryRelPath: 'fd',
    assetName: () => `fd-v${FD_VER}-${rustArch()}-apple-darwin.tar.gz`,
    assetUrl: () => `https://github.com/sharkdp/fd/releases/download/v${FD_VER}/${CLIS.fd.assetName()}`,
    // fd publishes no checksums → pin the per-arch hex (verified at pin time; bump with FD_VER).
    checksum: {
      kind: 'pinned',
      hex: {
        arm64: 'ae6327ba8c9a487cd63edd8bddd97da0207887a66d61e067dfe80c1430c5ae36',
        x64: '991a648a58870230af9547c1ae33e72cb5c5199a622fe5e540e162d6dba82d48',
      },
    },
  },
  jq: {
    id: 'jq',
    label: 'jq',
    blurb: 'a JSON processor',
    pinnedVersion: JQ_VER,
    probeBinary: 'jq',
    format: 'raw',
    assetName: () => `jq-macos-${cliArch() === 'x64' ? 'amd64' : 'arm64'}`,
    assetUrl: () => `https://github.com/jqlang/jq/releases/download/jq-${JQ_VER}/${CLIS.jq.assetName()}`,
    checksum: { kind: 'file', url: () => `https://github.com/jqlang/jq/releases/download/jq-${JQ_VER}/sha256sum.txt` },
  },
}

export const CLI_IDS = Object.keys(CLIS) as CliId[]
