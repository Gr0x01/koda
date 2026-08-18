/**
 * Workspace resolver — SHAPE ONLY, deliberately unimplemented and unwired.
 *
 * This file exists so the next build session starts from an agreed seam rather than re-deriving one.
 * It contains types and signatures; there is no implementation, no module state, and no call site.
 * Adding one is build step 1 of Documents/architecture/session-workstream-isolation.md, and the
 * plan's own sequencing rule holds: nothing may turn on until the consumer inventory
 * (Documents/architecture/session-workstream-root-inventory.md) and this resolver both exist.
 *
 * The whole point of the file: today `cwd` means fourteen different things and is resolved in two
 * unrelated places — `rootForSender()` (the caller's *window*, 74 IPC channels) and
 * `getSessionCwd()` (the session's spawn dir, 1 channel). A second root spread outward from the
 * engine is what sank the rejected attempt across 56 files. Resolving inward through one owner is
 * the replacement, and branded types are what make a swap a compile error instead of a review catch.
 */
import type { EngineId } from '@shared/ipc'

// ── Branded roots ────────────────────────────────────────────────────────────
//
// Nominal, not structural: a `string` never satisfies these, and a ProjectRoot never satisfies
// WorkspaceRoot. Every function in §7 of the inventory that currently takes `projectDir: string`
// takes one of these instead, which is what turns "did this handler use the right root?" from a
// review question into a build failure.

/** Durable identity of the project the user opened: window, session archive, project memory, Koda
 *  metadata, backup identity, registered live mini app. Never moves when a session binds. */
export type ProjectRoot = string & { readonly __projectRoot: unique symbol }

/** The checkout one workstream executes in: engine cwd and sandbox, user Git, source files, that
 *  workstream's safety history, Terminal, Preview, Changes, recovery. Moves when a session binds. */
export type WorkspaceRoot = string & { readonly __workspaceRoot: unique symbol }

/**
 * The workspace an engine conversation was CREATED in, which is not the same as the workspace it is
 * currently bound to. Claude files transcripts at `~/.claude/projects/<slug(cwd)>/<id>.jsonl` and a
 * session resumed from a different cwd keeps appending to the original file — proven in
 * spike/workspace-bind/README.md §2. The four `session-store.ts` readers of on-disk conversations
 * must use this, or a bound session reports "no conversation" and silently respawns clean.
 */
export type ConversationRoot = string & { readonly __conversationRoot: unique symbol }

/** Sole sanctioned way to mint a `ProjectRoot`: realpath-resolved, absolute, and validated once at
 *  the point a user actually picks a folder. */
export declare function asProjectRoot(absoluteRealPath: string): ProjectRoot

/** Sole sanctioned way to mint a `WorkspaceRoot`. Only the coordinator calls this, after it has
 *  validated the checkout's Git top level and common dir. */
export declare function asWorkspaceRoot(absoluteRealPath: string): WorkspaceRoot

// ── Records ──────────────────────────────────────────────────────────────────

export interface ProjectContext {
  id: string
  projectRoot: ProjectRoot
}

/** Why a workstream has the workspace it has. `canonical` is the project checkout itself (and the
 *  target of the legacy `cwd`-only migration); `shared-folder` is the non-Git policy, which is one
 *  writable folder with one writer lease and never a silent `git init`. */
export type WorkstreamKind = 'canonical' | 'git-worktree' | 'shared-folder'

/** `creating` and `missing` are reconciled against Git on relaunch; neither is ever silently rebound
 *  to the canonical checkout. */
export type WorkstreamState = 'creating' | 'ready' | 'missing' | 'integrated' | 'retained'

export interface WorkstreamRecord {
  id: string
  projectId: string
  workspaceRoot: WorkspaceRoot
  kind: WorkstreamKind
  state: WorkstreamState
  git?: {
    branchRef: string
    baseRef: string
    commonDir: string
    /** False for a worktree adopted from `git worktree list` — discoverable, never auto-deleted. */
    managedByKoda: boolean
  }
  createdAt: number
  updatedAt: number
}

/** `read` is the inherited attachment: it sees the files but holds no writer lease and creates no Git
 *  state. `write` is what the binding handshake produces, persisted before the first write. */
export type WorkspaceAuthority = 'read' | 'write'

export interface SessionWorkspaceBinding {
  sessionId: string
  projectId: string
  workstreamId: string
  authority: WorkspaceAuthority
}

/** Everything a caller can need from a `sessionId`, resolved in one hop so no surface has to decide
 *  which root it meant. `conversationRoot` is absent until the engine conversation exists. */
export interface ResolvedSessionRoots {
  binding: SessionWorkspaceBinding
  projectRoot: ProjectRoot
  workspaceRoot: WorkspaceRoot
  conversationRoot?: ConversationRoot
  engineId?: EngineId
}

// ── The binding handshake ────────────────────────────────────────────────────
//
// The semantic judgment ("is this the same work?") stays with the engine; validation and
// materialization stay here. The engine supplies human meaning only — Koda chooses and validates the
// branch ref and filesystem path.

export type BindIntent =
  | { intent: 'continue'; workstreamId: string }
  | { intent: 'new'; name: string }

/** What a read-attached engine is shown so it can choose: title, branch label, state, last activity.
 *  Deliberately no filesystem paths — the engine never names a root. */
export interface WorkstreamOffer {
  workstreamId: string
  title: string
  branchLabel?: string
  state: WorkstreamState
  lastActivityAt: number
}

/** A refused bind keeps the prior read attachment and names the concrete Git error; it never degrades
 *  to writing in the canonical checkout. */
export type BindResult =
  | { ok: true; binding: SessionWorkspaceBinding; workspaceRoot: WorkspaceRoot; relocated: boolean }
  | { ok: false; reason: 'unknown-workstream' | 'not-eligible' | 'git-failed' | 'workspace-unavailable'; message: string }

/** The non-approvable gate result a read-attached engine gets when it reaches a write-capable tool.
 *  Distinct from an approval denial precisely because it cannot be approved past — the same turn may
 *  bind and continue, which is the recovery, not a user decision. */
export interface WorkspaceBindingRequired {
  kind: 'workspace_binding_required'
  sessionId: string
  offers: readonly WorkstreamOffer[]
}

// ── Access leases ────────────────────────────────────────────────────────────
//
// Ephemeral main-process state keyed by workstreamId: shared read claims, or one exclusive writer.
// Not restored after a crash — no writer process survived one. Workstream records are restored.

/** Released only after the engine turn, its writable delegates, and its completion reconciliation
 *  have all ended. A parent cannot release at TurnComplete while a background delegate still runs. */
export interface AccessClaim {
  readonly workstreamId: string
  readonly authority: WorkspaceAuthority
  release(): void
}

/** Why a caller is waiting, so the session row can say "Waiting for Build Issues to finish editing"
 *  instead of falling back to a generic uncertainty badge. */
export interface LeaseWait {
  workstreamId: string
  holderSessionId: string
  holderLabel: string
}

// ── IPC route scope registry ─────────────────────────────────────────────────

/**
 * Every filesystem-affecting IPC route declares which root it resolves against. `project-global-
 * mutation` is the serialized lane for `.koda/memory`, guardrails, and project skills: canonical
 * content, but separately leased and separately checkpointed, and never staged onto whichever
 * feature branch happens to write it.
 *
 * A test walks the registry and fails when a new filesystem-affecting handler has no declaration.
 * That tripwire is what stops the next ambiguous path from being introduced by accident.
 */
export type IpcRootScope = 'project' | 'workspace' | 'project-global-mutation'

export type IpcRootScopeRegistry = Readonly<Record<string, IpcRootScope>>

// ── The coordinator ──────────────────────────────────────────────────────────

/**
 * One instance, owned by the main process. It is the ONLY thing allowed to translate a `sessionId`
 * into a root. No renderer, phone client, IPC handler, or engine driver accepts a free-form workspace
 * path — which is why `StartSessionRequestSchema.cwd` and the phone's eight `projectPath` wire
 * parameters have to close before any of this turns on.
 */
export interface WorkspaceCoordinator {
  /** Every root a caller could want, in one hop. Throws for an unknown session: "not bound" is a
   *  state to render, never a reason to substitute `projectRoot` or `process.cwd()`. */
  resolve(sessionId: string): ResolvedSessionRoots

  /** Project identity for a window. Unaffected by any session's binding. */
  projectFor(windowId: number): ProjectContext | undefined

  /** A new session inherits the source session's workstream read-only; a project-level start with no
   *  source attaches canonical. Creates no Git state and takes no writer lease. */
  attachRead(sessionId: string, sourceSessionId: string | undefined, projectId: string): SessionWorkspaceBinding

  /** What a read-attached engine may choose between. Ids and human labels only. */
  offersFor(projectId: string): readonly WorkstreamOffer[]

  /** Validate and materialize the engine's declared intent, then persist the binding BEFORE any
   *  write. `relocated: true` means the caller must respawn or relocate the engine into the new root
   *  and — per spike/workspace-bind/README.md §3 — tell the model in-band that its workspace moved.
   *  A relocated process reads the new root correctly, but the model keeps aiming writes at the old
   *  one until it is told; "reread after relocation" alone is not sufficient. */
  bind(sessionId: string, intent: BindIntent): Promise<BindResult>

  /** Shared read claim for a dispatched turn. Waits while a writer holds the workstream, so a fresh
   *  review never inspects a half-written tree. */
  acquireRead(sessionId: string): Promise<AccessClaim>

  /** FIFO upgrade to the exclusive writer lease. The first requester becomes upgrade owner and is
   *  promoted once other read claims finish. A losing second requester must have its logical attempt
   *  cancelled before any write, its user turn buffered, and its read claim released — it cannot keep
   *  the claim the winner is waiting on. */
  acquireWrite(sessionId: string): Promise<AccessClaim>

  /** Who holds the workstream, for concrete waiting copy. */
  waitingOn(workstreamId: string): LeaseWait | undefined

  /** Reconcile persisted `creating`/`missing` records against Git on relaunch, and adopt worktrees
   *  discovered via `git worktree list --porcelain`. May finish or recreate a checkout only when the
   *  branch identity makes that lossless; otherwise it surfaces the concrete workspace problem and
   *  leaves the branch untouched. */
  reconcile(projectId: string): Promise<void>

  /** Old `cwd`-only session records become one `canonical` legacy workstream with
   *  `projectRoot === workspaceRoot`. They are never moved retroactively.
   *  OPEN (inventory §11.8): a project whose sessions were spawned in different directories collapses
   *  into one record under this signature. Confirm with RB before implementing. */
  migrateLegacySessions(projectId: string): Promise<void>
}
