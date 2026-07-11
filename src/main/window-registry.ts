/**
 * Window ↔ project ↔ sessions registry — the spine of one-project-per-window (ui-workspace.md §9).
 * A window IS a project: opening a folder gives it its own OS window; a new project is a new window.
 *
 * Two consumers read this: `EngineSessionManager` routes each session's events to its OWNING window
 * (replacing the old single-window `getAllWindows()[0]`), and the Files-browser fs IPC resolves the
 * caller's project root from it (so reads/writes are contained to *that window's* project). Keeping
 * it module-level in its own file avoids an import cycle — sessions.ts and ipc.ts import from here,
 * never the reverse.
 *
 * Keyed by `BrowserWindow.id` (a stable integer for the window's lifetime, never reused).
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

export interface WindowContext {
  win: BrowserWindow
  /** Absolute, realpath-resolved project root. '' for a ProjectHome window before a folder is picked. */
  projectPath: string
  /** Engine sessions started in this window — drives per-window event routing + teardown on close. */
  sessionIds: Set<string>
  /** Unguessable host token for this window's `koda-preview://` origin (preview.ts). Used instead of
   *  the integer window id so a previewed app can't enumerate other windows' tokens to read their
   *  projects' files across the preview protocol. */
  previewToken: string
}

const registry = new Map<number, WindowContext>()

export function registerWindow(win: BrowserWindow, projectPath: string): void {
  registry.set(win.id, { win, projectPath, sessionIds: new Set(), previewToken: randomUUID() })
}

/** Drop a window's context on close; returns the snapshot so the caller can tear down its sessions. */
export function unregisterWindow(winId: number): WindowContext | undefined {
  const ctx = registry.get(winId)
  registry.delete(winId)
  return ctx
}

export function contextForWindow(winId: number): WindowContext | undefined {
  return registry.get(winId)
}

/** The window owning a session — O(windows), fine for the handful a user runs concurrently. */
export function contextForSession(sessionId: string): WindowContext | undefined {
  for (const ctx of registry.values()) if (ctx.sessionIds.has(sessionId)) return ctx
  return undefined
}

export function projectPathForWindow(winId: number): string | undefined {
  return registry.get(winId)?.projectPath
}

/** This window's `koda-preview://` host token (for building preview URLs). */
export function previewTokenForWindow(winId: number): string | undefined {
  return registry.get(winId)?.previewToken
}

/** Resolve a `koda-preview://` host token back to its window — the protocol handler uses this to
 *  scope a preview request to the right project root (and reject unknown/stale tokens). */
export function contextForPreviewToken(token: string): WindowContext | undefined {
  for (const ctx of registry.values()) if (ctx.previewToken === token) return ctx
  return undefined
}

/** Set the project once a ProjectHome window's folder is picked — the only time projectPath mutates. */
export function setProjectPath(winId: number, projectPath: string): void {
  const ctx = registry.get(winId)
  if (ctx) ctx.projectPath = projectPath
}

export function addSessionToWindow(winId: number, sessionId: string): void {
  registry.get(winId)?.sessionIds.add(sessionId)
}

export function removeSessionFromWindow(sessionId: string): void {
  for (const ctx of registry.values()) if (ctx.sessionIds.delete(sessionId)) return
}

/** The window already showing this project, if any — for block-and-focus on duplicate opens. */
export function windowForProject(projectPath: string): BrowserWindow | undefined {
  for (const ctx of registry.values()) if (ctx.projectPath === projectPath) return ctx.win
  return undefined
}
