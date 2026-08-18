/**
 * The Electron-coupled wiring around the (Electron-free) AssistEngine: resolves the bundled helper,
 * reads the user's toggle live, and exposes the task verbs the IPC layer + safety-git call. Lazy so
 * the helper path is resolved once, after `app` is ready. Like everything in this seam, the verbs
 * never throw — titles/labels return their deterministic floor and version subjects return null for
 * the composer to keep its own floor (engine.ts).
 */
import { app } from 'electron'
import { AssistEngine } from './engine'
import { resolveAssistHelperPath } from './binary'
import { loadAssistEnabled } from '../settings'

let engine: AssistEngine | null = null

function getEngine(): AssistEngine {
  if (!engine) {
    const helperPath = resolveAssistHelperPath({
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    })
    // Enabled is read per-call so toggling the setting takes effect without an app restart.
    // Choosing Apple/Claude/plain is handled by the generated-text callers. This remaining toggle
    // owns only recovery labels, so turning those off cannot silently disable an explicit Apple
    // choice in the text-generation picker.
    engine = new AssistEngine({ helperPath, enabled: (task) => task !== 'label' || loadAssistEnabled() })
  }
  return engine
}

/** A clean session title from a prompt or work digest; `avoid` = sibling names it must not collide with. */
export function assistTitle(text: string, avoid: string[] = []): Promise<string> {
  return getEngine().assist('title', text, avoid)
}

/** A calm, human-readable label for a safety-git recovery point. */
export function assistLabel(text: string): Promise<string> {
  return getEngine().assist('label', text)
}

/** One imperative saved-version subject from Apple Foundation Models, or null on every miss. */
export function assistVersionMessage(text: string): Promise<string | null> {
  return getEngine().generateVersion(text)
}
