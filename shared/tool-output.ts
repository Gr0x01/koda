const TOOL_OUTPUT_VISIBLE_CHARS = 2_000
const TOOL_OUTPUT_TRUNCATED = '… (showing latest)\n'

/**
 * The transcript only renders the newest part of a tool result. Keep that same bounded view in the
 * durable session payload so one verbose tool result cannot push an Electron IPC message toward its
 * ceiling and silently stop every chat in the project from being saved.
 */
export function compactToolOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_VISIBLE_CHARS) return output
  return TOOL_OUTPUT_TRUNCATED + output.slice(-(TOOL_OUTPUT_VISIBLE_CHARS - TOOL_OUTPUT_TRUNCATED.length))
}

type StoredItem = Record<string, unknown>

function compactStoredTool<T extends StoredItem>(tool: T): T {
  // This tool's `result` is structured answer state, parsed by QuestionCard after a restart. It does
  // not render through ToolCard, so truncating it would turn answered prompts into "Skipped".
  if (tool.name === 'AskUserQuestion') return tool
  const result = typeof tool.result === 'string' ? compactToolOutput(tool.result) : tool.result
  const liveOutput =
    typeof tool.liveOutput === 'string' ? compactToolOutput(tool.liveOutput) : tool.liveOutput
  if (result === tool.result && liveOutput === tool.liveOutput) return tool
  return { ...tool, result, liveOutput }
}

/**
 * Compact tool output in the renderer transcript shape without depending on renderer-only types.
 * Both sides of the persistence boundary use this: renderer compacts before Electron IPC, and main
 * compacts again for windowless/phone and migration paths that write directly to disk.
 */
export function compactTranscriptToolOutput<T>(items: readonly T[]): T[] {
  return items.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const item = raw as StoredItem
    if (item.kind === 'tool') return compactStoredTool(item) as T
    if (item.kind !== 'subagent' || !Array.isArray(item.children)) return raw

    let changed = false
    const children = item.children.map((child) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) return child
      const record = child as StoredItem
      if (record.kind !== 'tool') return child
      const compacted = compactStoredTool(record)
      if (compacted !== record) changed = true
      return compacted
    })
    return (changed ? { ...item, children } : item) as T
  })
}
