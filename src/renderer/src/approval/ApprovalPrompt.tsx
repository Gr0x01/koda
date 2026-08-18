import { useEffect } from 'react'
import type { ApprovalMode, ApprovalRequest } from '@shared/ipc'
import { Markdown } from '../output/Markdown'
import { Button } from '../ui'
import { windowHasOpenModal } from '../window-modal'

/**
 * "Ask me" mode — a tool is waiting on the user. Shown above the composer; the engine waits
 * indefinitely until answered (or the session ends, which clears it). Allow/Deny only in v0 —
 * inline input editing (allow-with-edit) is a later refinement. Vibecoder default is Auto-approve,
 * so this surface is the cautious opt-in, not the common path.
 *
 * ExitPlanMode is special-cased: it's an always-confirm tool (gate/policy) carrying a markdown
 * `plan`, so instead of a raw tool prompt we render the plan itself and (Cursor-style) let the user
 * pick HOW to build — Auto (build now) or Check first (review each step) — which sets the session's
 * tier. That chosen tier rides back through `onAllow(mode)` and the engine self-exits plan into it.
 */
export function ApprovalPrompt({
  request,
  onAllow,
  onDeny,
  active = false,
}: {
  request: ApprovalRequest
  onAllow: (postPlanMode?: ApprovalMode) => void
  onDeny: () => void
  /** Bind keyboard shortcuts — set only for the sole pending prompt so a keystroke is unambiguous. */
  active?: boolean
}) {
  // Keyboard: A = Allow, D or Esc = Deny. No bare Enter (a reflexive Enter must never approve a tool).
  // Scoped to the plain tool prompt — ExitPlanMode has three distinct choices, so it stays mouse-only
  // (Esc still dismisses it as "keep planning"). Ignored while typing in a field.
  useEffect(() => {
    if (!active) return
    const isPlan = request.toolName === 'ExitPlanMode'
    function onKey(e: KeyboardEvent): void {
      if (windowHasOpenModal()) return
      if (isEditableTarget(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'escape' || k === 'd') {
        e.preventDefault()
        onDeny()
      } else if (k === 'a' && !isPlan) {
        e.preventDefault()
        onAllow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, request.toolName, onAllow, onDeny])

  if (request.toolName === 'ExitPlanMode') {
    const plan = (request.input as { plan?: unknown } | null)?.plan
    return (
      <div className="mb-2 rounded-2xl border border-accent/40 bg-surface px-5 py-4 shadow-soft">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-text-muted">Claude's plan · review before building</div>
        {/* The plan is the thing to read, so give it most of the screen and let the buttons stay pinned
            below. A soft bottom fade signals "more below" instead of a hard cut when it does overflow. */}
        <div className="relative">
          <div className="max-h-[55vh] overflow-auto pr-1">
            <Markdown>{typeof plan === 'string' ? plan : 'No plan text provided.'}</Markdown>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface to-transparent" />
        </div>
        {/* Dismiss sits bottom-left, apart from the two build actions on the right — the standard
            "back out" vs "commit" split so Keep planning never reads as one of the go choices. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={onDeny}>
            Keep planning
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => onAllow('ask')}
              title="Build, but ask before each edit and command"
            >
              Review each step
            </Button>
            <Button
              variant="primary"
              onClick={() => onAllow('auto')}
              title="Build now, approving as it goes (destructive git + recovery still confirm)"
            >
              Approve &amp; build
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Just-in-time tool install — shown in plain language (the raw MCP tool name means nothing to a
  // non-engineer). The blurbs mirror the main-process registry's runtimes + CLIs (renderer can't
  // import it, so kept in sync by hand).
  if (request.toolName === 'mcp__koda_broker__ensure_tool') {
    const id = (request.input as { tool_id?: unknown } | null)?.tool_id
    const tool = typeof id === 'string' ? CLI_TOOLS[id] : undefined
    const name = tool?.name ?? (typeof id === 'string' ? id : 'a tool')
    return (
      <div className="mb-2 rounded-lg border border-accent/40 bg-surface px-4 py-3">
        <div className="text-sm text-text">
          The agent wants to set up <span className="font-medium">{name}</span>
          {tool ? <span className="text-text-muted"> — {tool.blurb}</span> : null}.
        </div>
        <div className="mt-1 text-xs text-text-muted">
          Koda downloads it into its own folder — nothing else on your Mac changes.
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="danger" onClick={onDeny}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => onAllow()}>
            Set up
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-2 rounded-lg border border-accent/40 bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-accent">⚙ {request.toolName}</span>
        <span className="text-text-muted">wants to run</span>
      </div>
      {request.reason && (
        <div className="mt-2 text-xs text-text">
          {request.reason}
        </div>
      )}
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">
        {summarize(request.input)}
      </pre>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="danger" onClick={onDeny}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => onAllow()}>
          Allow
        </Button>
      </div>
    </div>
  )
}

/** Don't fire approval shortcuts while the user is typing (composer, rename fields, etc.). */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

/** Plain-language names for the installable tools + runtimes (mirrors registry.ts RUNTIMES/CLIS — kept
 *  in sync by hand; the renderer can't import a main-process module). Unknown ids fall back to the raw id. */
const CLI_TOOLS: Record<string, { name: string; blurb: string }> = {
  node: { name: 'Node', blurb: 'for apps that save data or run a server' },
  python: { name: 'Python', blurb: 'for data, scripts & AI tools' },
  ripgrep: { name: 'ripgrep', blurb: 'a fast file-search tool' },
  fd: { name: 'fd', blurb: 'a fast file finder' },
  jq: { name: 'jq', blurb: 'a JSON processor' },
}

/** A readable view of the tool input — the key field on its own line, else pretty JSON. */
function summarize(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  const pick = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : undefined)
  const headline = pick('file_path') ?? pick('path') ?? pick('command') ?? pick('pattern') ?? pick('query')
  if (headline) return headline
  const json = JSON.stringify(input ?? {}, null, 2)
  return json.length > 600 ? json.slice(0, 600) + '\n…' : json
}
