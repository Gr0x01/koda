/**
 * The user's real login-shell PATH.
 *
 * A Finder-launched .app inherits only launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) —
 * NOT the PATH the user's shell builds in ~/.zshrc / ~/.zprofile. So an agent Bash command, or a
 * preview dev server, can't find `node`/`npm`/`python3` the user installed via Homebrew, nvm,
 * pyenv, etc. — even when it's right there. We capture the login shell's PATH once and use it as
 * the base for every spawn (the engine and dev servers both).
 *
 * This RESPECTS the user's existing environment; it does not provide a runtime on a machine that
 * has none (that's a separate, deliberate decision). Captured PATH only — never the rest of the
 * shell env, so nothing stripped in buildEngineEnv (a stray ANTHROPIC_API_KEY) sneaks back in.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Sensible Mac defaults when we can't ask the shell (covers Homebrew on both arches). */
const FALLBACK = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

let cached: string | undefined
const provisionedBins = new Map<string, string>() // runtime id → bin dir

/** The login-shell PATH alone, resolved once per app run. */
function loginPath(): string {
  if (cached === undefined) cached = resolve()
  return cached
}

/**
 * Register the bin dir of a Koda-provisioned runtime (provision.ts), keyed by runtime id (node /
 * python). Prepended to every spawn's PATH so it's found, but only ever set when the user had no
 * system copy — a true fallback, not an override (see provision's status check). Takes effect on the
 * next spawn, no restart.
 */
export function setProvisionedBin(id: string, binDir: string): void {
  provisionedBins.set(id, binDir)
}

/** Does the user's login PATH already contain `name`? (login PATH only — excludes our provisioned bin.)
 *  `excludeDirs` drops PATH entries that don't count as a real install — e.g. macOS's `/usr/bin/python3`
 *  is a stub that just triggers the Xcode CLT installer (and is PEP-668 restricted), not a usable Python. */
export function loginPathHasBinary(name: string, excludeDirs: readonly string[] = []): boolean {
  return loginPath()
    .split(':')
    .some((dir) => dir.length > 0 && !excludeDirs.includes(dir) && existsSync(join(dir, name)))
}

/** The PATH every engine + dev-server spawn uses: login-shell PATH, with any provisioned runtimes in front. */
export function userPath(): string {
  const prov = [...provisionedBins.values()]
  return prov.length ? `${prov.join(':')}:${loginPath()}` : loginPath()
}

/**
 * Env for every `git` spawn — user-git AND safety-git/backup alike. The hole is narrower than "bare
 * `git` always ENOENTs": launchd's minimal PATH still has /usr/bin, so on a machine with Xcode CLT
 * the spawn resolves fine. It bites machines WITHOUT CLT (where /usr/bin/git is a stub that fires the
 * installer dialog and exits non-zero) and any git installed only under /opt/homebrew/bin — plus
 * git's own PATH lookup of subcommands and credential helpers, which is the already-proven
 * runUserGit "bad credentials" failure. One resolver so a new call site can't quietly reopen it.
 *
 * Trade-off taken deliberately: safety-git and backup/bundle.ts are Koda-owned helpers designed to be
 * independent of the user's environment (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL=/dev/null), and this
 * routes them through the login-shell PATH — so a version-manager shim (mise/asdf) early on PATH now
 * supplies the git that runs the undo net. Caller `extra` folds in BEFORE PATH — nobody drops the fix.
 */
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, PATH: userPath() }
}

function resolve(): string {
  const ambient = process.env.PATH ?? ''
  const shell = process.env.SHELL
  // `npm run dev` already runs under a real shell PATH; only the GUI .app is starved.
  if (!shell) return ambient || FALLBACK

  try {
    // -i -l so rc + profile both run (where PATH is built); sentinel-wrapped so we ignore any
    // banner noise an interactive rc prints. stdin ignored + a timeout so a shell that blocks on
    // input can't hang the main process.
    const out = execFileSync(shell, ['-ilc', 'command echo "__KODA_PATH__${PATH}__END__"'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const captured = /__KODA_PATH__(.*?)__END__/s.exec(out)?.[1]?.trim()
    if (captured) return merge(captured, ambient)
  } catch {
    // Exotic shell (fish joins $PATH with spaces), no rc, timeout — fall back gracefully.
  }
  return ambient || FALLBACK
}

/** Prefer the shell's PATH; append any ambient entry it didn't already include (never lose one). */
function merge(shellPath: string, ambient: string): string {
  const seen = new Set(shellPath.split(':').filter(Boolean))
  const extras = ambient.split(':').filter((p) => p && !seen.has(p))
  return extras.length ? `${shellPath}:${extras.join(':')}` : shellPath
}
